/**
 * Map between client-facing model IDs (JB profile IDs like
 * `anthropic-claude-4-7-opus`) and the canonical provider IDs that the
 * JB native passthrough endpoints (`/user/v5/llm/<provider>/...`) expect
 * (like `claude-opus-4-7`).
 *
 * resolve(modelId):
 *   - returns { family, nativeId } when the model can be routed to a
 *     native passthrough endpoint
 *   - returns null otherwise — caller should fall back to the aggregated
 *     chat/stream endpoint with the existing converters
 */

// JB profile ID → native Anthropic model ID. Verified from the
// /anthropic/v1/messages "Unsupported model" error list.
const ANTHROPIC_PROFILE_TO_NATIVE = {
  'anthropic-claude-4-sonnet':   'claude-sonnet-4-20250514',
  'anthropic-claude-4.1-opus':   'claude-opus-4-1-20250805',
  'anthropic-claude-4-5-sonnet': 'claude-sonnet-4-5-20250929',
  'anthropic-claude-4-5-haiku':  'claude-haiku-4-5-20251001',
  'anthropic-claude-4-5-opus':   'claude-opus-4-5-20251101',
  'anthropic-claude-4-6-opus':   'claude-opus-4-6',
  'anthropic-claude-4-6-sonnet': 'claude-sonnet-4-6',
  'anthropic-claude-4-7-opus':   'claude-opus-4-7',
};

// JB profile ID → native OpenAI model ID (chat.completions-compatible).
// Codex variants are in OPENAI_CODEX_PROFILE_TO_NATIVE below — they only
// work on the Responses endpoint, not chat/completions.
const OPENAI_PROFILE_TO_NATIVE = {
  'openai-gpt-4':        'gpt-4',
  'openai-gpt-4-turbo':  'gpt-4-turbo',
  'openai-gpt-4o':       'gpt-4o',
  'openai-gpt-4o-mini':  'gpt-4o-mini',
  'openai-o1':           'o1',
  'openai-o3':           'o3',
  'openai-o3-mini':      'o3-mini',
  'openai-o4-mini':      'o4-mini',
  'openai-gpt4.1':       'gpt-4.1',
  'openai-gpt4.1-mini':  'gpt-4.1-mini',
  'openai-gpt4.1-nano':  'gpt-4.1-nano',
  'openai-gpt-5':        'gpt-5',
  'openai-gpt-5-mini':   'gpt-5-mini',
  'openai-gpt-5-nano':   'gpt-5-nano',
  'openai-gpt-5-1':      'gpt-5.1',
  'openai-gpt-5-2':      'gpt-5.2',
  'openai-gpt-5-4':      'gpt-5.4',
  'openai-gpt-5-4-mini': 'gpt-5.4-mini',
  'openai-gpt-5-4-nano': 'gpt-5.4-nano',
};

// Codex variants — only reachable via /openai/v1/responses, rejected by
// chat/completions.
const OPENAI_CODEX_PROFILE_TO_NATIVE = {
  'openai-gpt-5-codex':        'gpt-5-codex',
  'openai-gpt-5-1-codex':      'gpt-5.1-codex',
  'openai-gpt-5-1-codex-mini': 'gpt-5.1-codex-mini',
  'openai-gpt-5-1-codex-max':  'gpt-5.1-codex-max',
  'openai-gpt-5-2-codex':      'gpt-5.2-codex',
  'openai-gpt-5-3-codex':      'gpt-5.3-codex',
};

// xAI profile ID → native Grok model ID. All five variants have Responses
// support in practice even though the Profile.features field omits it.
const XAI_PROFILE_TO_NATIVE = {
  'xai-grok-4':                      'grok-4-0709',
  'xai-grok-4-fast':                 'grok-4-fast-reasoning',
  'xai-grok-4-1-fast':               'grok-4-1-fast-reasoning',
  'xai-grok-4-1-fast-non-reasoning': 'grok-4-1-fast-non-reasoning',
  'xai-grok-code-fast-1':            'grok-code-fast-1-0825',
};

/**
 * Resolve a client-facing model ID for routing.
 *
 * @param {string} modelId
 * @param {'chat'|'responses'} endpoint - which JB native endpoint the
 *   caller is about to hit. codex variants resolve to openai only when
 *   endpoint === 'responses'; xAI resolves only on responses.
 */
function resolve(modelId, endpoint = 'chat') {
  if (!modelId || typeof modelId !== 'string') return null;

  // Anthropic — only meaningful on the Anthropic messages endpoint (the
  // caller in /v1/messages), never on OpenAI/xAI endpoints.
  if (ANTHROPIC_PROFILE_TO_NATIVE[modelId]) {
    return { family: 'anthropic', nativeId: ANTHROPIC_PROFILE_TO_NATIVE[modelId] };
  }
  if (modelId.startsWith('claude-')) {
    return { family: 'anthropic', nativeId: modelId };
  }

  // xAI — Responses endpoint only.
  if (endpoint === 'responses') {
    if (XAI_PROFILE_TO_NATIVE[modelId]) {
      return { family: 'xai', nativeId: XAI_PROFILE_TO_NATIVE[modelId] };
    }
    if (modelId.startsWith('grok-')) {
      return { family: 'xai', nativeId: modelId };
    }
  }

  // OpenAI codex — only usable on Responses endpoint.
  if (modelId.includes('codex')) {
    if (endpoint === 'responses') {
      if (OPENAI_CODEX_PROFILE_TO_NATIVE[modelId]) {
        return { family: 'openai', nativeId: OPENAI_CODEX_PROFILE_TO_NATIVE[modelId] };
      }
      // bare native codex ID
      return { family: 'openai', nativeId: modelId };
    }
    // chat/completions endpoint: fall through to aggregated path
    return null;
  }

  // OpenAI (non-codex) — works on both chat/completions and responses.
  if (OPENAI_PROFILE_TO_NATIVE[modelId]) {
    return { family: 'openai', nativeId: OPENAI_PROFILE_TO_NATIVE[modelId] };
  }
  // Raw OpenAI native IDs (gpt-*, o1/o3/o4, including dated pins like
  // gpt-5-2025-08-07). JB applies its own profile whitelist; if a model
  // isn't available the 400 is forwarded verbatim to the client.
  if (/^(gpt-|o[134]($|-))/.test(modelId)) {
    return { family: 'openai', nativeId: modelId };
  }

  return null;
}

module.exports = { resolve };
