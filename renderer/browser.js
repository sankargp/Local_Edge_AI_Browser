'use strict';

const tabsEl = document.getElementById('tabs');
const address = document.getElementById('address');
const messages = document.getElementById('messages');
const prompt = document.getElementById('agent-prompt');
const status = document.getElementById('agent-status');
const modelAction = document.getElementById('model-action');
const speechModelAction = document.getElementById('speech-model-action');
const speechStatus = document.getElementById('speech-status');
const composer = document.getElementById('composer');
const mic = document.getElementById('mic');
const send = document.getElementById('send');
const stop = document.getElementById('stop');
const approval = document.getElementById('approval');
const controls = { back: document.getElementById('back'), forward: document.getElementById('forward'), reload: document.getElementById('reload') };
let browserState = { activeTabId: null, tabs: [] };
let sidebarOpen = true;
let busy = false;
let approvalState = null;
let currentModel = null;
let speechState = { state: 'unavailable', reason: 'Checking offline speech…' };
let voiceState = 'idle';
let mediaStream = null;
let mediaRecorder = null;
let recordingStartedAt = 0;
let recordingInterval = null;
let recordingTimeout = null;
let voiceGeneration = 0;
let savedSelection = { start: 0, end: 0 };
const requestedRecordingLimit = Number(new URLSearchParams(window.location.search).get('voiceMaxMs'));
const MAX_RECORDING_MS = requestedRecordingLimit > 0 && requestedRecordingLimit <= 120000 ? requestedRecordingLimit : 120000;

const active = () => browserState.tabs.find((tab) => tab.id === browserState.activeTabId);
function renderTabs() {
  for (const node of [...tabsEl.querySelectorAll('.tab')]) node.remove();
  for (const tab of browserState.tabs) {
    const el = document.createElement('div'); el.className = `tab${tab.id === browserState.activeTabId ? ' active' : ''}`;
    const title = document.createElement('span'); title.className = 'tab-title'; title.textContent = `${tab.isLoading ? '◌ ' : ''}${tab.title}`;
    const close = document.createElement('button'); close.title = 'Close tab'; close.textContent = '×';
    el.append(title, close); el.onclick = () => window.browser.activateTab(tab.id);
    close.onclick = (event) => { event.stopPropagation(); window.browser.closeTab(tab.id); };
    tabsEl.insertBefore(el, document.getElementById('new-tab'));
  }
  const tab = active(); address.value = tab?.url === 'about:blank' ? '' : (tab?.url || '');
  controls.back.disabled = !tab?.canGoBack; controls.forward.disabled = !tab?.canGoForward;
  document.getElementById('tab-context').textContent = tab ? `Active: ${tab.title}` : 'No active tab';
}

function setSidebar(open) {
  sidebarOpen = !!open; document.body.classList.toggle('sidebar-closed', !sidebarOpen);
  document.getElementById('assistant-toggle').classList.toggle('active', sidebarOpen);
  window.browser.setSidebar(sidebarOpen);
  if (!sidebarOpen) cancelVoice();
}

function removeWelcome() { document.getElementById('welcome')?.remove(); }
function addMessage(text, role, isError = false) {
  removeWelcome(); const row = document.createElement('article'); row.className = `message ${role}${isError ? ' error' : ''}`;
  const label = document.createElement('div'); label.className = 'message-label'; label.textContent = role === 'user' ? 'You' : 'Assistant';
  const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = text;
  row.append(label, bubble); messages.appendChild(row); messages.scrollTop = messages.scrollHeight; return row;
}
function addActivity(name, args, label = 'Working') {
  removeWelcome(); const item = document.createElement('div'); item.className = 'activity';
  const strong = document.createElement('strong'); strong.textContent = name.replaceAll('_', ' ');
  item.append(`${label}: `, strong); if (args?.tabId) item.append(` · tab ${String(args.tabId).slice(0, 8)}`);
  messages.appendChild(item); messages.scrollTop = messages.scrollHeight; return item;
}
function setBusy(value) {
  busy = !!value;
  updateComposerControls();
  if (busy) { status.textContent = approvalState ? 'Waiting for your approval' : 'Working across your tabs…'; status.className = 'busy'; }
  else if (currentModel) setModel(currentModel);
}
function setModel(model) {
  if (!model) return;
  currentModel = model;
  if (model.state === 'available') { status.textContent = `${model.model} · Ready`; status.className = 'ready'; modelAction.hidden = true; }
  else if (model.state === 'downloadable') { status.textContent = `${model.model} · Download required`; status.className = ''; modelAction.hidden = false; }
  else if (model.state === 'downloading') { status.textContent = 'Downloading local model…'; status.className = 'busy'; modelAction.hidden = true; }
  else { status.textContent = model.reason || `Model ${model.state}`; status.className = 'error'; modelAction.hidden = model.state !== 'downloadable'; }
}

function voiceIsActive() { return ['requesting', 'recording', 'transcribing'].includes(voiceState); }
function formatElapsed(milliseconds) {
  const seconds = Math.max(0, Math.min(120, Math.floor(milliseconds / 1000)));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
function setSpeechStatus(text = '', kind = '') {
  speechStatus.textContent = text; speechStatus.className = kind;
}
function updateComposerControls() {
  const activeVoice = voiceIsActive();
  send.hidden = busy; stop.hidden = !busy; send.disabled = activeVoice;
  prompt.disabled = busy; prompt.readOnly = activeVoice;
  const modelBlocksRecording = ['unavailable', 'model-required', 'downloading'].includes(speechState.state);
  mic.disabled = busy || voiceState === 'requesting' || (!activeVoice && modelBlocksRecording);
  mic.dataset.state = voiceState; mic.setAttribute('aria-pressed', String(voiceState === 'recording'));
  mic.setAttribute('aria-label', voiceState === 'recording' ? 'Stop and transcribe recording' : voiceState === 'transcribing' ? 'Cancel transcription' : 'Start voice recording');
  mic.title = mic.getAttribute('aria-label');
  composer.classList.toggle('recording', voiceState === 'recording');
  document.body.dataset.voiceState = voiceState;
}
function setSpeechState(next) {
  if (!next) return;
  speechState = next;
  speechModelAction.hidden = next.state !== 'model-required';
  if (!voiceIsActive()) {
    if (next.state === 'unavailable') setSpeechStatus(next.reason || 'Voice unavailable', 'error');
    else if (next.state === 'model-required') setSpeechStatus('Voice model required');
    else if (next.state === 'downloading') setSpeechStatus('Downloading voice model…');
    else if (voiceState !== 'error') setSpeechStatus('');
  }
  updateComposerControls();
}
function setVoiceState(next) { voiceState = next; updateComposerControls(); }
function clearRecordingTimers() {
  clearInterval(recordingInterval); clearTimeout(recordingTimeout);
  recordingInterval = null; recordingTimeout = null;
}
function releaseMedia() {
  if (mediaStream) for (const track of mediaStream.getTracks()) track.stop();
  mediaStream = null; mediaRecorder = null;
}
function showVoiceError(error) {
  setVoiceState('error');
  const message = error?.name === 'NotAllowedError' ? 'Microphone permission was denied' : (error?.message || String(error));
  setSpeechStatus(message, 'error');
}
async function startRecording() {
  if (busy || voiceIsActive() || speechState.state !== 'ready') return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    showVoiceError(new Error('Audio recording is unavailable')); return;
  }
  const generation = ++voiceGeneration;
  savedSelection = { start: prompt.selectionStart ?? prompt.value.length, end: prompt.selectionEnd ?? prompt.value.length };
  setVoiceState('requesting'); setSpeechStatus('Requesting microphone…');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (generation !== voiceGeneration || voiceState !== 'requesting') { for (const track of stream.getTracks()) track.stop(); return; }
    mediaStream = stream;
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    recorder.addEventListener('dataavailable', (event) => { if (event.data?.size) chunks.push(event.data); });
    recorder.addEventListener('error', (event) => { cancelVoice(); showVoiceError(event.error || new Error('Recording failed')); });
    recorder.addEventListener('stop', () => transcribeRecording(chunks, recorder.mimeType, generation));
    mediaRecorder = recorder; recordingStartedAt = Date.now(); recorder.start(500);
    setVoiceState('recording'); setSpeechStatus('Recording 0:00 / 2:00', 'recording');
    recordingInterval = setInterval(() => setSpeechStatus(`Recording ${formatElapsed(Date.now() - recordingStartedAt)} / 2:00`, 'recording'), 250);
    recordingTimeout = setTimeout(() => stopRecording(true), MAX_RECORDING_MS);
  } catch (error) {
    if (generation === voiceGeneration) { releaseMedia(); showVoiceError(error); }
  }
}
function stopRecording(shouldTranscribe) {
  if (voiceState === 'requesting') {
    voiceGeneration += 1; releaseMedia(); setVoiceState('idle'); setSpeechStatus('Recording cancelled'); return;
  }
  if (voiceState !== 'recording' || !mediaRecorder) return;
  clearRecordingTimers();
  const recorder = mediaRecorder;
  if (!shouldTranscribe) voiceGeneration += 1;
  setVoiceState(shouldTranscribe ? 'transcribing' : 'idle');
  setSpeechStatus(shouldTranscribe ? 'Preparing transcription…' : 'Recording cancelled');
  try { recorder.stop(); } catch { /* already stopped */ }
  if (mediaStream) for (const track of mediaStream.getTracks()) track.stop();
  mediaStream = null;
}
async function transcribeRecording(chunks, mimeType, generation) {
  mediaRecorder = null;
  if (generation !== voiceGeneration || voiceState !== 'transcribing') return;
  try {
    const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
    if (!blob.size) throw new Error('No audio was recorded');
    const audio = await window.voiceAudio.wavFromBlob(blob);
    if (generation !== voiceGeneration) return;
    setSpeechStatus('Transcribing locally…');
    const result = await window.assistant.transcribeAudio(audio);
    if (generation !== voiceGeneration) return;
    if (!result.text?.trim()) {
      setVoiceState('idle'); setSpeechStatus('No speech detected'); return;
    }
    const insertion = window.voiceAudio.insertTranscript(prompt.value, savedSelection.start, savedSelection.end, result.text);
    prompt.value = insertion.value; prompt.focus(); prompt.setSelectionRange(insertion.selectionStart, insertion.selectionEnd);
    setVoiceState('idle'); setSpeechStatus('Transcript ready');
  } catch (error) {
    if (generation !== voiceGeneration || error?.name === 'AbortError') return;
    showVoiceError(error);
  }
}
function cancelVoice() {
  if (!voiceIsActive()) return;
  voiceGeneration += 1; clearRecordingTimers();
  if (voiceState === 'recording' && mediaRecorder) { try { mediaRecorder.stop(); } catch { /* already stopped */ } }
  releaseMedia();
  if (voiceState === 'transcribing') window.assistant.cancelTranscription().catch(() => {});
  setVoiceState('idle'); setSpeechStatus('Voice cancelled');
}
function showApproval(next) {
  approvalState = next; approval.hidden = !next;
  if (!next) { if (busy) { status.textContent = 'Working across your tabs…'; status.className = 'busy'; } return; }
  document.getElementById('approval-action').textContent = next.action.replaceAll('_', ' ');
  document.getElementById('approval-tab').textContent = `${next.tabTitle}\n${next.url}`;
  document.getElementById('approval-target').textContent = next.target || next.file?.name || 'Browser tab';
  document.getElementById('approval-effect').textContent = next.effect;
  document.getElementById('approval-values').textContent = JSON.stringify(next.file || next.values || {}, null, 2);
  status.textContent = 'Waiting for your approval'; status.className = 'busy';
}

window.browser.onTabs((next) => { browserState = next; renderTabs(); });
window.browser.onLayout((layout) => { sidebarOpen = layout.sidebarOpen; document.body.classList.toggle('sidebar-closed', !layout.sidebarOpen); document.getElementById('assistant-toggle').classList.toggle('active', layout.sidebarOpen); });
window.assistant.onEvent((event) => {
  if (event.type === 'message') addMessage(event.text, event.role, event.error);
  else if (event.type === 'state') setBusy(event.busy);
  else if (event.type === 'tool-start') addActivity(event.name, event.args);
  else if (event.type === 'tool-end') addActivity(event.name, null, 'Completed');
  else if (event.type === 'approval') showApproval(event.approval);
  else if (event.type === 'approval-cleared') showApproval(null);
  else if (event.type === 'model') setModel(event.state);
  else if (event.type === 'model-progress') { const p = event.progress; status.textContent = p.total ? `Downloading local model · ${Math.round((p.completed || 0) / p.total * 100)}%` : (p.status || 'Downloading local model…'); }
  else if (event.type === 'speech-state') setSpeechState(event.state);
  else if (event.type === 'speech-model-progress') { const p = event.progress; setSpeechStatus(p.total ? `Voice model ${Math.round((p.received || 0) / p.total * 100)}%` : 'Downloading voice model…'); }
  else if (event.type === 'download-progress') status.textContent = event.total ? `Downloading ${event.filename} · ${Math.round(event.received / event.total * 100)}%` : `Downloading ${event.filename}…`;
  else if (event.type === 'cleared') { messages.innerHTML = '<div class="welcome" id="welcome"><div class="spark">✦</div><h2>What should I do?</h2><p>The session is clear. Ask me to read or act on any tab.</p></div>'; showApproval(null); }
});

document.getElementById('new-tab').onclick = () => window.browser.newTab();
address.addEventListener('keydown', (event) => { if (event.key === 'Enter' && browserState.activeTabId) window.browser.navigate(browserState.activeTabId, address.value); });
controls.back.onclick = () => window.browser.back(browserState.activeTabId); controls.forward.onclick = () => window.browser.forward(browserState.activeTabId); controls.reload.onclick = () => window.browser.reload(browserState.activeTabId);
document.getElementById('assistant-toggle').onclick = () => setSidebar(!sidebarOpen); document.getElementById('close-sidebar').onclick = () => setSidebar(false);
document.getElementById('clear').onclick = () => { cancelVoice(); window.assistant.clear(); }; stop.onclick = () => window.assistant.cancel();
document.getElementById('approve').onclick = () => approvalState && window.assistant.approve(approvalState.id).catch((error) => addMessage(error.message, 'assistant', true));
document.getElementById('reject').onclick = () => approvalState && window.assistant.reject(approvalState.id).catch((error) => addMessage(error.message, 'assistant', true));
document.getElementById('composer').addEventListener('submit', async (event) => {
  event.preventDefault(); const text = prompt.value.trim(); if (!text || busy || voiceIsActive()) return;
  prompt.value = ''; addMessage(text, 'user'); setBusy(true);
  try { await window.assistant.send(text); } catch (error) { if (busy) { addMessage(error.message || String(error), 'assistant', true); setBusy(false); } }
});
prompt.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); document.getElementById('composer').requestSubmit(); } });
document.querySelectorAll('.suggestion').forEach((button) => { button.onclick = () => { prompt.value = button.textContent; prompt.focus(); }; });
modelAction.onclick = async () => { modelAction.hidden = true; try { setModel(await window.assistant.downloadModel()); } catch (error) { addMessage(`Unable to download the model: ${error.message}`, 'assistant', true); } };
speechModelAction.onclick = async () => {
  speechModelAction.hidden = true; setSpeechState({ ...speechState, state: 'downloading' });
  try { setSpeechState(await window.assistant.downloadSpeechModel()); }
  catch (error) { setSpeechState(await window.assistant.getSpeechState().catch(() => speechState)); showVoiceError(error); }
};
mic.onclick = () => {
  if (voiceState === 'recording') stopRecording(true);
  else if (voiceState === 'transcribing') cancelVoice();
  else startRecording();
};
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && voiceIsActive()) { event.preventDefault(); cancelVoice(); } });
window.addEventListener('beforeunload', cancelVoice);

window.assistant.getState().then((initial) => { setBusy(initial.busy); setModel(initial.model); if (initial.awaitingApproval) showApproval(initial.awaitingApproval); }).catch((error) => { status.textContent = error.message; status.className = 'error'; });
window.assistant.getSpeechState().then(setSpeechState).catch((error) => setSpeechState({ state: 'unavailable', reason: error.message }));
updateComposerControls();
