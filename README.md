# Local AI Browser — starter skeleton

An Electron app shell (browser + hosted apps) that exposes a **Prompt-API-compatible
`window.ai`** to web pages, backed by a **local NVIDIA inference sidecar** (Ollama /
`gpt-oss:20b`). No cloud, no egress — inference runs on the local GPU.


**Demo Video(Youtube):**
[![Demo video](https://img.youtube.com/vi/z-jASVTIYXk/maxresdefault.jpg)](https://www.youtube.com/watch?v=z-jASVTIYXk)

This is a runnable skeleton of the architecture we designed: a browser-owned AI
sidebar, audited multi-tab page automation, origin allowlist + per-capability
permission prompts, in-page JS tool calling, JSON-Schema structured output,
streaming chat, file upload, and model auto-detect/download.

## Prerequisites

- **Windows + NVIDIA GPU** (the target). Works on other platforms for dev too.
- **Node.js 18+** and **Electron** (`npm install`).
- **[Ollama](https://ollama.com)** installed. The app tries to `ollama serve` on launch.
- The model: `ollama pull gpt-oss:20b` (or let the in-app download flow pull it).
- For voice input, Windows microphone access must be enabled for desktop apps. The
  bundled Windows x64 CPU runtime does not require CUDA.

## Run

```bash
npm install
npm start
```

The app opens as a tabbed browser. Enter an `http` or `https` URL in the address
bar; each tab has an independent live renderer. Pages can call `window.ai` to use
the local model after the user grants native consent for that origin.

The browser chrome also includes a persistent **AI Assistant** sidebar. It can read
DOM-accessible page content, coordinate tabs, fill standard form controls, follow
links, inspect images, and prepare uploads or downloads. Submit, send, purchase,
delete, close-tab, upload, and download operations pause on an exact one-time
approval card before execution. Sidebar history exists only in memory for the
current app run.

The sidebar composer also supports optional **offline voice input**. Select the
microphone, download the 142 MiB English speech model on first use, record for up
to two minutes, and select the microphone again to transcribe. The transcript is
inserted at the original cursor position for review; it is never sent
automatically. Audio remains on the device and temporary WAV/transcript files are
removed after each attempt.

For a complete multi-tab demonstration, open the bundled **Customer Intake** tab
and ask: “Open https://jsonplaceholder.typicode.com/users/1 in a new tab, read the
customer information, return to the Customer Intake tab, and populate the matching
fields. Do not submit the form.” A second request to submit displays the one-time
approval card before the local demo record is created.

## What each file does

| File | Responsibility |
|---|---|
| `src/main.js` | Electron main. Supervises the sidecar, owns the live tab views and navigation, hosts all `ai:*` IPC handlers, and runs the **tool round-trip back into the originating page**. |
| `src/browser-agent.js` | Browser-owned assistant session, audited tool schemas, multi-tab orchestration, approval lifecycle, downloads, and uploads. |
| `src/speech.js` | Checksum-verified speech-model download, bounded WAV validation, one-at-a-time local Whisper execution, cancellation, and temporary-file cleanup. |
| `src/media-permissions.js` | Restricts Chromium microphone permission to audio-only requests from the browser chrome. |
| `src/page-automation.js` | Chromium accessibility/DOM observation, opaque element references, and fixed page actions through the DevTools protocol. |
| `src/agent-policy.js` | URL validation, bounded tool results, argument validation, and deterministic consequential-action classification. |
| `src/browser-preload.js` / `renderer/browser.html` | The privileged browser chrome: tab strip, address bar, and navigation controls. |
| `src/preload.js` | Injects `window.ai` **only into allowlisted origins** (checked via `sendSync`). Keeps tool `execute` fns in the renderer world; builds sessions, streaming iterators, file pick. |
| `src/gateway.js` | The broker. Session store, **single-concurrency priority GPU queue**, prompt/response **cache**, and the **tool-call loop**. Transport-agnostic. |
| `src/ollama.js` | Minimal sidecar client: `chat` (tools + JSON-Schema `format`), `chatStream`, `pullModel`, `listModels`, `ping`. |
| `src/models.js` | Capability probe (`nvidia-smi` VRAM), availability states, model download. |
| `src/permissions.js` | Origin allowlist + native consent dialogs + per-origin capability grants. |
| `config/models.json` | Model tiering (`default` 20B, optional `fast` small model). |
| `renderer/demo.html` | Demo web app: Summarize locally, structured "classify each", file Q&A, streaming chat. |

## The `window.ai` contract (what web developers use)

```js
// availability + model management
const a = await window.ai.availability({ tier: 'default' });   // 'available' | 'downloadable' | ...
await window.ai.download({ tier: 'default' }, p => console.log(p));

// create a session (triggers native permission prompt on first use)
const session = await window.ai.languageModel.create({
  systemPrompt: 'You summarize work orders.',
  tools: [{
    name: 'getVisibleWorkOrders',
    description: 'Returns work orders currently visible.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => window.app.getVisibleWorkOrders()   // runs IN THE PAGE
  }]
});

// structured output (constrained decoding against a JSON Schema)
const json = await session.prompt('Classify each work order.', { responseConstraint: mySchema });

// streaming chat
for await (const chunk of session.promptStreaming('Summarize these.')) render(chunk);

// file upload as context (native picker, permission-gated)
const file = await window.ai.files.pick();   // { name, text }
```

## Security model (how the constraints are enforced)

- **Top-level pages only.** `preload.js` asks main (`sendSync`) whether the current
  top-level page is eligible; embedded frames never receive `window.ai`. Every `ai:*`
  IPC handler in `main.js` re-checks that the request comes from the same top-level tab
  that owns the session, so frame/navigation tricks cannot smuggle access.
- **Ask permission.** First `create()` (and first `files.pick()`) per origin shows a
  **native** dialog (`src/permissions.js`). Grants persist in memory per origin.
- **No inference egress.** The inference path has no remote-model client — the gateway
  talks only to the local sidecar over loopback. Pages themselves can of course load
  their normal web content over the network.
- **Local voice transcription.** Recorded audio is converted to 16 kHz mono WAV in
  memory and sent only to the Electron main process. Visited pages and subframes are
  denied microphone permission. The only speech-related network operation is the
  explicit first-use model download; audio and transcripts are never uploaded.
- **Prompt-injection containment.** Page content enters as *data* in the user turn, never
  as system instructions. The model can only call tools declared at `create()` time, and
  those tools are the page's own JS functions — so a successful injection can at worst
  invoke functions the page already exposes to itself.
- **Browser agent containment.** The sidebar model receives only fixed, schema-validated
  tools. It cannot provide JavaScript or selectors for execution. Element references
  are bound to a tab and navigation and are invalidated when that page changes.
- **Consequential action approval.** High-impact actions are classified in application
  code, previewed in browser chrome, revalidated after approval, and authorized only
  once. Page content and model output cannot waive this check.

## Tests

```bash
npm test                 # policy and gateway tests
npm run test:electron    # hidden real-page automation smoke test
npm run test:voice       # hidden fake-microphone voice composer smoke test
```

## Offline speech runtime

The application includes the Windows x64 CPU `whisper.cpp` runtime from release
`v1.9.4` / build `b5130` (source commit `927cfce`) under
`resources/whisper/win-x64`. The archive and individual runtime hashes, version,
and MIT license are stored beside it. Development builds may override the CLI
path with `WHISPER_CPP_PATH`; release packaging must copy `resources/whisper` to
the unpacked Electron resources directory so the executable is not placed inside
`app.asar`.

The English `ggml-base.en.bin` model is not bundled. An explicit UI action downloads
the pinned model revision into Electron's user-data `speech-models` directory via a
temporary file, then checks its exact size and SHA-256 before making it available.
An interrupted or invalid download is deleted. Removing that model file restores
the first-use download state.

The automation layer is DOM-first. Canvas-only applications, remote desktops,
closed shadow roots, CAPTCHA imagery, and other pixel-only interfaces require a
future vision-capable control path.

## Production hardening (deliberately left as seams)

- **Named pipe + launch token** instead of loopback HTTP for the sidecar
  (`OLLAMA_URL` / `OLLAMA_TOKEN` env seams in `ollama.js`).
- **Model tiering**: route high-count per-row extraction to the `fast` model, keep 20B
  for summaries/chat (pass `tier: 'fast'` to `create()`).
- **Streaming + tools together** (skeleton keeps them on separate paths for clarity).
- **Signed allowlist config** and an optional MDM/Intune-pushed policy file
  (the allowlist is already a clean external config seam).
- **Batch coalescing** for "summarize each of N rows" and richer cache eviction.
