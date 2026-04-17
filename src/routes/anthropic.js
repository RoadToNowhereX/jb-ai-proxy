const express = require('express');
const { convertRequest } = require('../converter/anthropic-to-jb');
const { convertStreamToAnthropic } = require('../converter/jb-to-anthropic');
const { endpointFor } = require('../converter/parameters');
const modelId = require('../model-id');
const accountManager = require('../account-manager');
const jb = require('../jb-client');

const router = express.Router();

router.post('/v1/messages', async (req, res) => {
  try {
    const account = accountManager.getNext();
    if (!account) {
      return res.status(503).json({
        type: 'error',
        error: { type: 'overloaded_error', message: 'No active accounts' },
      });
    }

    const jwt = await accountManager.ensureValidJwt(account);

    // Native Anthropic passthrough — full JB /anthropic/v1/messages proxy,
    // preserves extended thinking, prompt caching, and every other native
    // feature unchanged.
    const mapping = modelId.resolve(req.body.model);
    if (mapping && mapping.family === 'anthropic') {
      return proxyNativeAnthropic(req, res, jwt, account, mapping.nativeId);
    }

    // Aggregated fallback for cross-provider requests (e.g. Anthropic client
    // calling GPT or Gemini through /v1/messages).
    const jbBody = convertRequest(req.body);
    const call = endpointFor(req.body.model) === 'responses' ? jb.responsesStream : jb.chatStream;
    const jbRes = await call(jwt, jbBody);

    if (!jbRes.ok) {
      const errText = await jbRes.text();
      const status = jbRes.status === 477 ? 429 : jbRes.status;
      if (jbRes.status === 477) account.status = 'quota_exhausted';
      return res.status(status).json({
        type: 'error',
        error: { type: 'api_error', message: errText },
      });
    }

    const isStream = req.body.stream !== false;
    await convertStreamToAnthropic(jbRes.body, res, req.body.model, isStream);
  } catch (err) {
    console.error('POST /v1/messages error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({
        type: 'error',
        error: { type: 'api_error', message: err.message },
      });
    }
  }
});

async function proxyNativeAnthropic(req, res, jwt, account, nativeId) {
  const body = { ...req.body, model: nativeId };
  const jbRes = await jb.nativeAnthropicMessages(jwt, body);

  if (!jbRes.ok) {
    const errText = await jbRes.text();
    const status = jbRes.status === 477 ? 429 : jbRes.status;
    if (jbRes.status === 477) account.status = 'quota_exhausted';
    // Try to forward Anthropic-shaped error body when present, otherwise wrap.
    try {
      const parsed = JSON.parse(errText);
      if (parsed && parsed.type === 'error') {
        return res.status(status).json(parsed);
      }
    } catch {}
    return res.status(status).json({
      type: 'error',
      error: { type: 'api_error', message: errText },
    });
  }

  const ct = jbRes.headers.get('content-type') || 'application/json';
  res.status(jbRes.status);
  res.setHeader('Content-Type', ct);
  if (ct.includes('text/event-stream')) {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
  }

  for await (const chunk of jbRes.body) {
    if (!res.write(chunk)) {
      // Client backpressure — wait for drain before continuing.
      await new Promise(resolve => res.once('drain', resolve));
    }
  }
  res.end();
}

module.exports = router;
