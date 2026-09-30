'use strict';

/**
 * Preload bridge: exposes a Prompt-API-compatible `window.ai` into the page — but ONLY
 * for allowlisted origins. On any other origin the API simply doesn't exist.
 *
 * Shape (aligned with the Chromium built-in Prompt API):
 *   await window.ai.availability({ tier })          -> 'available' | 'downloadable' | ...
 *   await window.ai.download({ tier }, onProgress)
 *   const s = await window.ai.languageModel.create({ systemPrompt, tools, tier })
 *   await s.prompt(text, { responseConstraint })    -> structured / tool-using
 *   for await (const chunk of s.promptStreaming(text)) { ... }   -> streaming chat
 *   const f = await window.ai.files.pick()          -> { name, text }
 *
 * Tools are page-registered JS functions. Their `execute` fns are kept HERE in the
 * renderer world (never crossing IPC). When the model calls a tool, main asks us to
 * run it and we return the result over a correlated channel.
 */

const { contextBridge, ipcRenderer } = require('electron');
const crypto = require('crypto');

// Default-deny: if the origin isn't allowlisted, don't define window.ai at all.
const allowed = ipcRenderer.sendSync('ai:is-origin-allowed');
if (!allowed) {
  // Intentionally expose nothing.
} else {
  // sessionId -> Map<toolName, executeFn>
  const toolRegistry = new Map();

  // Model-initiated tool calls: run the page's own JS function and return the result.
  ipcRenderer.on('ai:execute-tool', async (_e, { callId, sessionId, toolName, args }) => {
    try {
      const reg = toolRegistry.get(sessionId);
      const fn = reg && reg.get(toolName);
      if (!fn) throw new Error(`tool "${toolName}" is not registered`);
      const result = await fn(args || {});
      ipcRenderer.send('ai:tool-result', { callId, ok: true, result });
    } catch (err) {
      ipcRenderer.send('ai:tool-result', { callId, ok: false, error: String(err && err.message ? err.message : err) });
    }
  });

  function makeSession(sessionId) {
    return {
      sessionId,

      // Structured / tool-using single-shot. Returns the assistant string.
      async prompt(text, options = {}) {
        const res = await ipcRenderer.invoke('ai:prompt', { sessionId, text, options });
        return res.content;
      },

      // Streaming chat. Returns an async iterable of text chunks.
      promptStreaming(text, options = {}) {
        const streamId = crypto.randomUUID();
        const channel = `ai:stream:${streamId}`;
        const chunks = [];
        let done = false;
        let error = null;
        let notify = null;

        const onMsg = (_e, msg) => {
          if (msg.type === 'chunk') chunks.push(msg.token);
          else if (msg.type === 'done') done = true;
          else if (msg.type === 'error') { error = new Error(msg.error); done = true; }
          if (notify) { const n = notify; notify = null; n(); }
        };
        ipcRenderer.on(channel, onMsg);
        ipcRenderer.invoke('ai:prompt-stream', { sessionId, text, options, streamId });

        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                for (;;) {
                  if (error) { ipcRenderer.removeListener(channel, onMsg); throw error; }
                  if (chunks.length) return { value: chunks.shift(), done: false };
                  if (done) { ipcRenderer.removeListener(channel, onMsg); return { value: undefined, done: true }; }
                  await new Promise((r) => { notify = r; });
                }
              },
            };
          },
        };
      },

      async destroy() {
        toolRegistry.delete(sessionId);
        return ipcRenderer.invoke('ai:destroy', { sessionId });
      },
    };
  }

  const api = {
    // Capability probe: GPU/VRAM/model presence.
    availability: (opts = {}) => ipcRenderer.invoke('ai:availability', opts),

    // Download the model, with optional progress callback.
    download: (opts = {}, onProgress) => {
      if (onProgress) {
        const listener = (_e, p) => onProgress(p);
        ipcRenderer.on('ai:download-progress', listener);
        return ipcRenderer.invoke('ai:download', opts).finally(() =>
          ipcRenderer.removeListener('ai:download-progress', listener)
        );
      }
      return ipcRenderer.invoke('ai:download', opts);
    },

    languageModel: {
      async create({ systemPrompt, tools, tier } = {}) {
        // Send only tool METADATA to main; keep execute fns in this world.
        const toolMeta = (tools || []).map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
        const { sessionId } = await ipcRenderer.invoke('ai:create', { systemPrompt, tools: toolMeta, tier });

        const reg = new Map();
        (tools || []).forEach((t) => { if (typeof t.execute === 'function') reg.set(t.name, t.execute); });
        toolRegistry.set(sessionId, reg);

        return makeSession(sessionId);
      },
    },

    files: {
      pick: () => ipcRenderer.invoke('ai:files-pick'),
    },
  };

  contextBridge.exposeInMainWorld('ai', api);
}
