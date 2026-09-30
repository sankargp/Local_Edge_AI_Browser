'use strict';

/**
 * Minimal Ollama client for the local inference sidecar.
 *
 * In production you'd prefer a Windows named pipe + per-launch bearer token so nothing
 * is reachable on a TCP port. Ollama speaks loopback HTTP (127.0.0.1:11434) out of the box,
 * so the skeleton uses that. The BASE_URL and OLLAMA_TOKEN seams are here for when you
 * front the sidecar with your own broker binary.
 */

const BASE_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const TOKEN = process.env.OLLAMA_TOKEN || null; // launch token, optional

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (TOKEN) h['Authorization'] = `Bearer ${TOKEN}`;
  return h;
}

/** Is the sidecar up? */
async function ping() {
  try {
    const res = await fetch(`${BASE_URL}/api/tags`, { headers: headers() });
    return res.ok;
  } catch {
    return false;
  }
}

/** List locally-present models (for auto-detect). */
async function listModels() {
  const res = await fetch(`${BASE_URL}/api/tags`, { headers: headers() });
  if (!res.ok) throw new Error(`ollama /api/tags ${res.status}`);
  const data = await res.json();
  return (data.models || []).map((m) => m.name);
}

/** Pull/download a model, streaming progress via onProgress({status, completed, total}). */
async function pullModel(model, onProgress) {
  const res = await fetch(`${BASE_URL}/api/pull`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ model, stream: true }),
  });
  if (!res.ok) throw new Error(`ollama /api/pull ${res.status}`);
  await consumeNdjson(res, (obj) => onProgress && onProgress(obj));
}

/**
 * Non-streaming chat. Supports tools + JSON-Schema constrained output ('format').
 * Returns the raw Ollama message object: { role, content, tool_calls? }.
 */
async function chat({ model, messages, tools, format, options, signal }) {
  const body = { model, messages, stream: false };
  if (tools && tools.length) body.tools = tools;
  if (format) body.format = format; // JSON Schema object => constrained decoding
  if (options) body.options = options;
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`ollama /api/chat ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.message; // { role, content, tool_calls? }
}

/**
 * Streaming chat (plain text). Calls onToken(text) per chunk. Tools are intentionally
 * not used on the streaming path in this skeleton to keep the loop simple.
 */
async function chatStream({ model, messages, format, options, signal }, onToken) {
  const body = { model, messages, stream: true };
  if (format) body.format = format;
  if (options) body.options = options;
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`ollama /api/chat ${res.status}: ${await res.text()}`);
  let full = '';
  await consumeNdjson(res, (obj) => {
    const piece = obj?.message?.content || '';
    if (piece) {
      full += piece;
      onToken(piece);
    }
  });
  return full;
}

/** Read a newline-delimited JSON stream from a fetch Response. */
async function consumeNdjson(res, onObject) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        onObject(JSON.parse(line));
      } catch {
        /* ignore partial/garbage lines */
      }
    }
  }
}

module.exports = { BASE_URL, ping, listModels, pullModel, chat, chatStream };
