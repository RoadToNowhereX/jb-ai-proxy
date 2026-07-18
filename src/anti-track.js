const { loadConfig } = require('./config');

// Claude Code uses one of several Unicode apostrophe variants in this block.
// Replacing it with the plain ASCII apostrophe preserves the prompt while
// removing the identifier used to fingerprint the request source.
const TRACKING_REGEX =
  /(# currentDate\r?\n)Today(?:'|\u2019|\u02BC|\u02B9)s date is (\d{4})[/-](\d{2})[/-](\d{2})\.(\r?\n)/g;

function rewriteText(text) {
  return typeof text === 'string'
    ? text.replace(TRACKING_REGEX, "$1Today's date is $2-$3-$4.$5")
    : text;
}

function rewriteTextBlocks(blocks, type) {
  if (!Array.isArray(blocks)) return;
  for (const block of blocks) {
    if (block && block.type === type && typeof block.text === 'string') {
      block.text = rewriteText(block.text);
    }
  }
}

// Anthropic: body.system is a string or [{ type: 'text', text }].
function processAnthropicBody(body) {
  if (!body || typeof body !== 'object') return body;
  if (typeof body.system === 'string') body.system = rewriteText(body.system);
  else rewriteTextBlocks(body.system, 'text');
  return body;
}

// OpenAI Chat Completions: system/developer messages contain string or text blocks.
function processOpenAIBody(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return body;
  for (const message of body.messages) {
    if (!message || (message.role !== 'system' && message.role !== 'developer')) continue;
    if (typeof message.content === 'string') message.content = rewriteText(message.content);
    else rewriteTextBlocks(message.content, 'text');
  }
  return body;
}

// Responses API: instructions plus system input text blocks.
function processResponsesBody(body) {
  if (!body || typeof body !== 'object') return body;
  if (typeof body.instructions === 'string') body.instructions = rewriteText(body.instructions);
  if (!Array.isArray(body.input)) return body;
  for (const input of body.input) {
    if (!input || input.role !== 'system') continue;
    if (typeof input.content === 'string') input.content = rewriteText(input.content);
    else rewriteTextBlocks(input.content, 'input_text');
  }
  return body;
}

function applyAntiTrack(body, endpoint) {
  try {
    const cfg = loadConfig().anti_track || {};
    if (endpoint === 'messages' && cfg.messages !== false) return processAnthropicBody(body);
    if (endpoint === 'chat_completions' && cfg.chat_completions !== false) return processOpenAIBody(body);
    if (endpoint === 'responses' && cfg.responses === true) return processResponsesBody(body);
  } catch (err) {
    // A malformed body or config must never prevent the request from reaching
    // the upstream service.
    console.error('[anti-track] failed to process body:', err);
  }
  return body;
}

module.exports = {
  applyAntiTrack,
  processAnthropicBody,
  processOpenAIBody,
  processResponsesBody,
};
