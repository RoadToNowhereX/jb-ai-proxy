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

// JB profile ID → native Anthropic model ID. Native IDs verified from
// the Anthropic passthrough endpoint's "Unsupported model" error list.
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

function resolve(modelId) {
  if (!modelId || typeof modelId !== 'string') return null;

  // JB profile form: look up in the map
  if (ANTHROPIC_PROFILE_TO_NATIVE[modelId]) {
    return { family: 'anthropic', nativeId: ANTHROPIC_PROFILE_TO_NATIVE[modelId] };
  }

  // Native Anthropic form (either canonical or dated): pass through as-is
  if (modelId.startsWith('claude-')) {
    return { family: 'anthropic', nativeId: modelId };
  }

  return null;
}

module.exports = { resolve };
