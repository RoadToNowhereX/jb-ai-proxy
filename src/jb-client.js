const { loadConfig } = require('./config');

const JB_API_BASE = 'https://api.jetbrains.ai';
const JB_OAUTH_BASE = 'https://oauth.account.jetbrains.com';

class JBRequestError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'JBRequestError';
    this.url = details.url;
    this.method = details.method;
    this.phase = details.phase;
    this.status = details.status;
    this.code = details.code;
    this.type = details.type || 'unknown';
    this.attempt = details.attempt;
    this.retryable = Boolean(details.retryable);
    this.cause = details.cause;
    this.responseText = details.responseText;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function truncateText(text, max = 400) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function classifyFetchError(err) {
  const code = err?.cause?.code || err?.code || '';
  const name = err?.cause?.name || err?.name || 'Error';
  const msg = err?.cause?.message || err?.message || '';

  if (['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)) {
    return { type: 'timeout', retryable: true, code, summary: `${name}${code ? `/${code}` : ''}: ${msg}` };
  }

  if (['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ETIMEDOUT'].includes(code)) {
    return { type: 'network', retryable: true, code, summary: `${name}/${code}: ${msg}` };
  }

  if (name === 'TypeError' && /fetch failed/i.test(msg)) {
    return { type: 'network', retryable: true, code, summary: `${name}${code ? `/${code}` : ''}: ${msg}` };
  }

  return { type: 'unknown', retryable: false, code, summary: `${name}${code ? `/${code}` : ''}: ${msg}` };
}

function classifyStatus(status) {
  if (status === 401 || status === 403) return { type: 'auth', retryable: false };
  if (status === 429) return { type: 'rate_limit', retryable: true };
  if (status >= 500) return { type: 'server_error', retryable: true };
  if (status >= 400) return { type: 'client_error', retryable: false };
  return { type: 'unknown', retryable: false };
}

function formatRequestError(err) {
  if (!(err instanceof JBRequestError)) return err?.message || String(err);

  const parts = [];
  if (err.method && err.url) parts.push(`${err.method} ${err.url}`);
  if (err.phase) parts.push(`phase=${err.phase}`);
  if (err.type) parts.push(`type=${err.type}`);
  if (typeof err.status === 'number') parts.push(`status=${err.status}`);
  if (err.code) parts.push(`code=${err.code}`);
  if (typeof err.attempt === 'number') parts.push(`attempt=${err.attempt}`);
  parts.push(err.message);
  if (err.responseText) parts.push(`response=${truncateText(err.responseText)}`);
  return parts.join(' | ');
}

async function fetchWithRetry(url, options = {}) {
  const config = loadConfig();
  const policy = config.refresh_policy || {};
  const method = options.method || 'GET';
  const maxRetries = Number.isInteger(policy.max_retries) ? policy.max_retries : 2;
  const retryDelayMs = Number.isInteger(policy.retry_delay_ms) ? policy.retry_delay_ms : 1500;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;

      const responseText = await res.text();
      const classification = classifyStatus(res.status);
      const err = new JBRequestError(
        `HTTP ${res.status}${responseText ? `: ${truncateText(responseText)}` : ''}`,
        {
          url,
          method,
          phase: 'response',
          status: res.status,
          type: classification.type,
          attempt,
          retryable: classification.retryable,
          responseText,
        }
      );

      if (!classification.retryable || attempt > maxRetries) throw err;
      console.warn(`[jb-client] retrying request after HTTP error: ${formatRequestError(err)}`);
    } catch (err) {
      if (err instanceof JBRequestError) {
        if (attempt > maxRetries || !err.retryable) throw err;
        await sleep(retryDelayMs * attempt);
        continue;
      }

      const classification = classifyFetchError(err);
      const wrapped = new JBRequestError(classification.summary, {
        url,
        method,
        phase: 'fetch',
        type: classification.type,
        code: classification.code,
        attempt,
        retryable: classification.retryable,
        cause: err,
      });
      if (!classification.retryable || attempt > maxRetries) throw wrapped;
      console.warn(`[jb-client] retrying request after fetch error: ${formatRequestError(wrapped)}`);
    }

    await sleep(retryDelayMs * attempt);
  }
}

async function refreshIdToken(refreshToken) {
  const res = await fetchWithRetry(`${JB_OAUTH_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: 'ide',
    }),
  });
  return res.json();
}

async function registerGrazie(idToken) {
  const res = await fetchWithRetry(`${JB_API_BASE}/auth/jetbrains-jwt/register`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${idToken}`,
      'User-Agent': 'ktor-client',
    },
  });
  return res.json();
}

async function provideAccess(idToken, licenseId) {
  const res = await fetchWithRetry(`${JB_API_BASE}/auth/jetbrains-jwt/provide-access/license/v2`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${idToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'ktor-client',
    },
    body: JSON.stringify({ licenseId }),
  });
  return res.json();
}

async function getUserInfo(idToken) {
  try {
    const res = await fetchWithRetry(`${JB_API_BASE}/auth/jetbrains-jwt/user-info`, {
      headers: {
        'Authorization': `Bearer ${idToken}`,
        'User-Agent': 'ktor-client',
      },
    });
    return { ok: true, status: res.status, data: await res.json() };
  } catch (err) {
    if (err instanceof JBRequestError && typeof err.status === 'number') {
      return { ok: false, status: err.status, data: null };
    }
    throw err;
  }
}

async function getProfiles(jwt) {
  const res = await fetchWithRetry(`${JB_API_BASE}/user/v5/llm/profiles/v8`, {
    headers: {
      'grazie-authenticate-jwt': jwt,
      'User-Agent': 'ktor-client',
    },
  });
  return res.json();
}

async function getQuota(jwt) {
  const res = await fetchWithRetry(`${JB_API_BASE}/user/v5/quota/get`, {
    method: 'POST',
    headers: {
      'grazie-authenticate-jwt': jwt,
      'Content-Type': 'application/json',
      'User-Agent': 'ktor-client',
    },
    body: '{}',
  });
  return res.json();
}

function llmStream(jwt, body, path) {
  const config = loadConfig();
  return fetchWithRetry(`${JB_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'Accept-Charset': 'UTF-8',
      'Cache-Control': 'no-cache',
      'grazie-authenticate-jwt': jwt,
      'grazie-agent': JSON.stringify(config.grazie_agent),
      'User-Agent': 'ktor-client',
    },
    body: JSON.stringify(body),
  });
}

function chatStream(jwt, body) {
  return llmStream(jwt, body, '/user/v5/llm/chat/stream/v8');
}

function responsesStream(jwt, body) {
  return llmStream(jwt, body, '/user/v5/llm/responses/stream/v8');
}

function nativeProxy(jwt, body, path, signal) {
  const config = loadConfig();
  return fetchWithRetry(`${JB_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'grazie-authenticate-jwt': jwt,
      'grazie-agent': JSON.stringify(config.grazie_agent),
      'User-Agent': 'ktor-client',
    },
    body: JSON.stringify(body),
    signal,
  });
}

function nativeAnthropicMessages(jwt, body, signal) {
  return nativeProxy(jwt, body, '/user/v5/llm/anthropic/v1/messages', signal);
}

function nativeOpenaiChatCompletions(jwt, body, signal) {
  return nativeProxy(jwt, body, '/user/v5/llm/openai/v1/chat/completions', signal);
}

function nativeOpenaiResponses(jwt, body, signal) {
  return nativeProxy(jwt, body, '/user/v5/llm/openai/v1/responses', signal);
}

function nativeXaiResponses(jwt, body, signal) {
  return nativeProxy(jwt, body, '/user/v5/llm/xai/v1/responses', signal);
}

function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT');
  const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
  return JSON.parse(payload);
}

module.exports = {
  refreshIdToken, registerGrazie, provideAccess, getUserInfo,
  getProfiles, getQuota, chatStream, responsesStream,
  nativeAnthropicMessages, nativeOpenaiChatCompletions,
  nativeOpenaiResponses, nativeXaiResponses,
  decodeJwtPayload,
  JBRequestError,
  formatRequestError,
  JB_API_BASE, JB_OAUTH_BASE,
};
