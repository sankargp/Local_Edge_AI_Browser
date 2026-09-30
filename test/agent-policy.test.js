'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertSafeUrl, capResult, classifyConsequence } = require('../src/agent-policy');
const gateway = require('../src/gateway');
const ollama = require('../src/ollama');

test('safe URL policy permits browser URLs and blocks executable schemes', () => {
  assert.equal(assertSafeUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(assertSafeUrl('about:blank'), 'about:blank');
  assert.throws(() => assertSafeUrl('javascript:alert(1)'), /not allowed/);
  assert.throws(() => assertSafeUrl('data:text/html,test'), /not allowed/);
  assert.throws(() => assertSafeUrl('about:settings'), /about:blank/);
});

test('consequence classifier cannot be bypassed for fixed high-risk tools', () => {
  for (const name of ['download_resource', 'upload_file', 'close_tab']) {
    assert.equal(classifyConsequence(name, {}, {}).required, true);
  }
  assert.equal(classifyConsequence('press_key', { key: 'Enter' }, {}).required, true);
  assert.equal(classifyConsequence('click_element', {}, { tag: 'button', type: 'submit', name: 'Continue' }).required, true);
  assert.equal(classifyConsequence('click_element', {}, { role: 'button', name: 'Delete account' }).required, true);
  assert.equal(classifyConsequence('click_element', {}, { role: 'button', name: 'Expand details' }).required, false);
  assert.equal(classifyConsequence('type_text', { text: 'delete' }, {}).required, false);
});

test('tool output is capped before it enters model history', () => {
  const result = capResult('x'.repeat(100), 20);
  assert.match(result, /^x{20}/);
  assert.match(result, /truncated 80 characters/);
});

test('gateway runs only declared tools and reports lifecycle events', async () => {
  const original = ollama.chat;
  const calls = [];
  let turn = 0;
  ollama.chat = async () => turn++ === 0
    ? { role: 'assistant', content: '', tool_calls: [{ function: { name: 'allowed_tool', arguments: { value: 7 } } }] }
    : { role: 'assistant', content: 'complete' };
  const { sessionId } = gateway.createSession({
    origin: 'test://agent', ownerWebContentsId: 7, systemPrompt: 'test',
    tools: [{ name: 'allowed_tool', inputSchema: { type: 'object' } }], maxToolIterations: 3,
  });
  try {
    const result = await gateway.prompt(sessionId, 'run', {}, async (_id, name, args) => {
      calls.push(['execute', name, args]); return { ok: true };
    }, {
      onToolStart: (name) => calls.push(['start', name]),
      onToolEnd: (name) => calls.push(['end', name]),
    });
    assert.equal(result.content, 'complete');
    assert.deepEqual(calls.map((entry) => entry.slice(0, 2)), [
      ['start', 'allowed_tool'], ['execute', 'allowed_tool'], ['end', 'allowed_tool'],
    ]);
  } finally {
    gateway.destroySession(sessionId); ollama.chat = original;
  }
});

test('an aborted browser-agent prompt stops before model execution', async () => {
  const original = ollama.chat;
  let invoked = false;
  ollama.chat = async () => { invoked = true; return { role: 'assistant', content: 'unexpected' }; };
  const { sessionId } = gateway.createSession({ origin: 'test://agent', ownerWebContentsId: 8, tools: [] });
  const controller = new AbortController(); controller.abort();
  try {
    await assert.rejects(gateway.prompt(sessionId, 'run', { signal: controller.signal }, async () => {}), { name: 'AbortError' });
    assert.equal(invoked, false);
  } finally {
    gateway.destroySession(sessionId); ollama.chat = original;
  }
});
