'use strict';

const {
  processAnthropicBody,
  processOpenAIBody,
  processResponsesBody,
} = require('../src/anti-track');

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) { console.log(`[PASS] ${message}`); passed++; }
  else { console.error(`[FAIL] ${message}`); failed++; }
}

const tracking = (apostrophe = '\u2019', separator = '-') =>
  `# currentDate\nToday${apostrophe}s date is 2025${separator}07${separator}04.\n`;
const clean = "# currentDate\nToday's date is 2025-07-04.\n";

// T1: Anthropic string system prompt.
{
  const body = { system: tracking() };
  assert(processAnthropicBody(body) === body, 'T1: Anthropic mutates and returns the input body');
  assert(body.system === clean, 'T1: Anthropic string system prompt is rewritten');
}

// T2: Anthropic text blocks.
{
  const body = { system: [{ type: 'text', text: tracking() }, { type: 'tool', text: tracking() }] };
  processAnthropicBody(body);
  assert(body.system[0].text === clean, 'T2: Anthropic text block is rewritten');
  assert(body.system[1].text === tracking(), 'T2: Anthropic non-text block is unchanged');
}

// T3: OpenAI system string content.
{
  const body = { messages: [{ role: 'system', content: tracking() }] };
  processOpenAIBody(body);
  assert(body.messages[0].content === clean, 'T3: OpenAI system string is rewritten');
}

// T4: OpenAI developer text blocks.
{
  const body = { messages: [{ role: 'developer', content: [{ type: 'text', text: tracking() }] }] };
  processOpenAIBody(body);
  assert(body.messages[0].content[0].text === clean, 'T4: OpenAI developer text block is rewritten');
}

// T5: Responses instructions.
{
  const body = { instructions: tracking() };
  processResponsesBody(body);
  assert(body.instructions === clean, 'T5: Responses instructions are rewritten');
}

// T6: Responses system string content.
{
  const body = { input: [{ role: 'system', content: tracking() }] };
  processResponsesBody(body);
  assert(body.input[0].content === clean, 'T6: Responses system string is rewritten');
}

// T7: Responses input_text blocks.
{
  const body = { input: [{ role: 'system', content: [{ type: 'input_text', text: tracking() }] }] };
  processResponsesBody(body);
  assert(body.input[0].content[0].text === clean, 'T7: Responses input_text block is rewritten');
}

// T8: Non-matching content remains unchanged.
{
  const body = { system: 'ordinary system prompt' };
  const original = JSON.stringify(body);
  assert(processAnthropicBody(body) === body, 'T8: Non-matching body keeps its identity');
  assert(JSON.stringify(body) === original, 'T8: Non-matching body keeps its content');
}

// T9: All Unicode variants and both date separators are accepted.
{
  const body = { system: [
    { type: 'text', text: tracking('\u2019', '/') },
    { type: 'text', text: tracking('\u02BC', '-') },
    { type: 'text', text: tracking('\u02B9', '/') },
  ] };
  processAnthropicBody(body);
  assert(body.system.every(block => block.text === clean), 'T9: Unicode apostrophes and date separators are rewritten');
}

// T10: Missing or malformed expected fields never throw.
{
  let threw = false;
  try {
    processAnthropicBody({ system: null });
    processOpenAIBody({ messages: null });
    processResponsesBody({ instructions: null, input: [{ role: 'system', content: null }] });
    processResponsesBody(null);
  } catch {
    threw = true;
  }
  assert(!threw, 'T10: Null and malformed fields are safe');
}

console.log(`\n${passed + failed}/${passed + failed} tests run - ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
