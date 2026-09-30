'use strict';

/**
 * AI Gateway / broker.
 *
 * Owns everything between the injected window.ai API and the inference sidecar:
 *   - session store (systemPrompt + declared tools + rolling history)
 *   - a single-concurrency GPU queue with priority (a 20B on one GPU serializes)
 *   - a prompt/response cache keyed on (model, systemPrompt, prompt, schema)
 *   - the tool-call loop (tools execute IN THE PAGE via an injected executor)
 *
 * It is deliberately transport-agnostic: main.js supplies a `toolExecutor` callback
 * that knows how to run a page-registered JS function in the right renderer frame.
 */

const crypto = require('crypto');
const ollama = require('./ollama');

const MODELS = require('../config/models.json');
const MAX_TOOL_ITERATIONS = 5;

const sessions = new Map(); // sessionId -> { origin, model, systemPrompt, tools, history }
const cache = new Map(); // key -> assistant content string

/* ----------------------------- priority queue ---------------------------- */
// concurrency = 1 so we never oversubscribe the GPU. Priority: lower runs first.
const PRIORITY = { chat: 0, interactive: 1, batch: 2, background: 3 };
const queue = [];
let running = false;

function enqueue(priority, task) {
  return new Promise((resolve, reject) => {
    queue.push({ priority, task, resolve, reject });
    queue.sort((a, b) => a.priority - b.priority);
    drain();
  });
}

async function drain() {
  if (running) return;
  const item = queue.shift();
  if (!item) return;
  running = true;
  try {
    item.resolve(await item.task());
  } catch (e) {
    item.reject(e);
  } finally {
    running = false;
    if (queue.length) drain();
  }
}

/* ------------------------------- sessions -------------------------------- */
function createSession({ origin, ownerWebContentsId, systemPrompt, tools, tier, maxToolIterations }) {
  const sessionId = crypto.randomUUID();
  const modelId = (MODELS[tier] || MODELS.default).id;
  sessions.set(sessionId, {
    origin,
    ownerWebContentsId,
    model: modelId,
    ollamaOptions: (MODELS[tier] || MODELS.default).ollamaOptions || undefined,
    systemPrompt: systemPrompt || '',
    tools: Array.isArray(tools) ? tools : [], // [{name, description, inputSchema}]
    maxToolIterations: Number.isInteger(maxToolIterations) ? Math.min(Math.max(maxToolIterations, 1), 30) : MAX_TOOL_ITERATIONS,
    history: [],
  });
  return { sessionId, model: modelId };
}

function destroySession(sessionId) {
  sessions.delete(sessionId);
}

function destroySessionsForOwner(ownerWebContentsId) {
  for (const [sessionId, session] of sessions) {
    if (session.ownerWebContentsId === ownerWebContentsId) sessions.delete(sessionId);
  }
}

function getSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('unknown or expired session');
  return s;
}

function getSessionOwner(sessionId) {
  return getSession(sessionId).ownerWebContentsId;
}

function assertSessionOwner(sessionId, ownerWebContentsId) {
  if (getSessionOwner(sessionId) !== ownerWebContentsId) {
    throw new Error('session does not belong to this tab');
  }
}

/* ------------------------- tool schema translation ----------------------- */
// window.ai tool metadata -> Ollama tool spec.
function toOllamaTools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.inputSchema || { type: 'object', properties: {} },
    },
  }));
}

function cacheKey(model, systemPrompt, prompt, constraint) {
  const h = crypto.createHash('sha256');
  h.update(model + '\u0000' + systemPrompt + '\u0000' + prompt + '\u0000' + (constraint ? JSON.stringify(constraint) : ''));
  return h.digest('hex');
}

/* --------------------------------- prompt -------------------------------- */
/**
 * Non-streaming prompt with structured output + tool-call loop.
 * @param toolExecutor async (sessionId, toolName, args) => result  (runs page JS)
 */
async function prompt(sessionId, text, { responseConstraint, priority = 'interactive', signal } = {}, toolExecutor, lifecycle = {}) {
  const s = getSession(sessionId);

  // Cache only stateless single-shot calls (no prior history, no tools).
  const cacheable = s.history.length === 0 && s.tools.length === 0;
  const key = cacheKey(s.model, s.systemPrompt, text, responseConstraint);
  if (cacheable && cache.has(key)) {
    return { content: cache.get(key), cached: true };
  }

  // Build message list. Page content arrives as *data* in the user turn,
  // never as system instructions -> injection containment.
  const messages = [];
  if (s.systemPrompt) messages.push({ role: 'system', content: s.systemPrompt });
  messages.push(...s.history);
  messages.push({ role: 'user', content: text });

  const ollamaTools = s.tools.length ? toOllamaTools(s.tools) : undefined;

  let finalContent = '';
  for (let i = 0; i < s.maxToolIterations; i++) {
    if (signal?.aborted) throw Object.assign(new Error('operation aborted'), { name: 'AbortError' });
    const msg = await enqueue(PRIORITY[priority] ?? 1, () =>
      ollama.chat({
        model: s.model,
        messages,
        tools: ollamaTools,
        format: responseConstraint, // JSON Schema => constrained decoding
        options: s.ollamaOptions,
        signal,
      })
    );

    // Model wants to call one or more page-registered tools.
    if (msg.tool_calls && msg.tool_calls.length) {
      messages.push(msg); // record assistant's tool-call turn
      for (const call of msg.tool_calls) {
        const name = call.function?.name;
        const args = call.function?.arguments || {};
        // Only tools declared at create() time may run.
        if (!s.tools.some((t) => t.name === name)) {
          messages.push({ role: 'tool', content: `Error: tool "${name}" not permitted for this session.` });
          continue;
        }
        let result;
        try {
          lifecycle.onToolStart?.(name, args);
          result = await toolExecutor(sessionId, name, args); // <-- runs IN THE PAGE
        } catch (e) {
          if (e?.name === 'AbortError') throw e;
          result = { error: String(e && e.message ? e.message : e) };
        }
        lifecycle.onToolEnd?.(name, result);
        messages.push({ role: 'tool', content: typeof result === 'string' ? result : JSON.stringify(result) });
      }
      continue; // loop: let the model use tool results
    }

    finalContent = msg.content || '';
    break;
  }

  if (!finalContent) finalContent = 'I could not complete the request within the browser action limit.';

  // Persist conversational turn (skip if this was a pure structured extraction).
  s.history.push({ role: 'user', content: text });
  s.history.push({ role: 'assistant', content: finalContent });

  if (cacheable) cache.set(key, finalContent);
  return { content: finalContent, cached: false };
}

/* ------------------------------ promptStreaming -------------------------- */
/**
 * Streaming chat (plain text). onToken(text) fires per chunk. No tools on this path.
 */
async function promptStreaming(sessionId, text, { responseConstraint, priority = 'chat' } = {}, onToken) {
  const s = getSession(sessionId);
  const messages = [];
  if (s.systemPrompt) messages.push({ role: 'system', content: s.systemPrompt });
  messages.push(...s.history);
  messages.push({ role: 'user', content: text });

  const full = await enqueue(PRIORITY[priority] ?? 0, () =>
    ollama.chatStream({ model: s.model, messages, format: responseConstraint, options: s.ollamaOptions }, onToken)
  );

  s.history.push({ role: 'user', content: text });
  s.history.push({ role: 'assistant', content: full });
  return full;
}

module.exports = { createSession, destroySession, destroySessionsForOwner, getSessionOwner, assertSessionOwner, prompt, promptStreaming, enqueue };
