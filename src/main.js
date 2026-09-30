'use strict';

const { app, BrowserWindow, WebContentsView, ipcMain, session, webContents, dialog } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const crypto = require('crypto');
const { spawn } = require('child_process');
const perms = require('./permissions');
const gateway = require('./gateway');
const models = require('./models');
const { PageAutomation } = require('./page-automation');
const { BrowserAgent } = require('./browser-agent');
const { SpeechService } = require('./speech');
const { configureMediaPermissions } = require('./media-permissions');

const CHROME_HEIGHT = 88;
const SIDEBAR_WIDTH = 390;
const HOME_URL = pathToFileURL(path.join(__dirname, '..', 'renderer', 'pii-demo.html')).toString();
const CHAT_URL = pathToFileURL(path.join(__dirname, '..', 'renderer', 'chat.html')).toString();
const DIJKSTRA_URL = pathToFileURL(path.join(__dirname, '..', 'renderer', 'dijkstra-demo.html')).toString();
const CUSTOMER_INTAKE_URL = pathToFileURL(path.join(__dirname, '..', 'renderer', 'customer-intake-demo.html')).toString();
let mainWindow = null;
let sidecarProc = null;
let activeTabId = null;
let sidebarOpen = true;
let automation = null;
let browserAgent = null;
let speechService = null;
const tabs = new Map();

function startSidecar() {
  try {
    sidecarProc = spawn('ollama', ['serve'], { stdio: 'ignore', windowsHide: true });
    sidecarProc.on('error', () => { sidecarProc = null; });
    sidecarProc.on('exit', () => { sidecarProc = null; });
  } catch { sidecarProc = null; }
}
function stopSidecar() { if (sidecarProc && !sidecarProc.killed) try { sidecarProc.kill(); } catch { /* noop */ } }

function tabSnapshot(tab) {
  return { id: tab.id, title: tab.title, url: tab.url, isLoading: tab.isLoading,
    canGoBack: tab.view.webContents.canGoBack(), canGoForward: tab.view.webContents.canGoForward() };
}
function publishTabs() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('browser:tabs', {
    activeTabId, tabs: [...tabs.values()].map(tabSnapshot),
  });
}
function layoutActiveTab() {
  const tab = tabs.get(activeTabId);
  if (!mainWindow || !tab) return;
  const [width, height] = mainWindow.getContentSize();
  const sidebarWidth = sidebarOpen && width >= 900 ? SIDEBAR_WIDTH : 0;
  tab.view.setBounds({ x: 0, y: CHROME_HEIGHT, width: Math.max(0, width - sidebarWidth), height: Math.max(0, height - CHROME_HEIGHT) });
  mainWindow.webContents.send('browser:layout', { sidebarOpen: sidebarWidth > 0, sidebarWidth });
}
function showTab(id) {
  const next = tabs.get(id);
  if (!next || !mainWindow) return;
  const current = tabs.get(activeTabId);
  if (current && current.id !== id) mainWindow.contentView.removeChildView(current.view);
  activeTabId = id;
  if (!mainWindow.contentView.children.includes(next.view)) mainWindow.contentView.addChildView(next.view);
  layoutActiveTab();
  publishTabs();
}
function normaliseUrl(input) {
  const value = String(input || '').trim();
  if (!value) return 'about:blank';
  if (value === HOME_URL || value === CHAT_URL) return value;
  // The address bar is also useful for loading local demo pages. Preserve an
  // explicitly entered file URL instead of treating it as an HTTPS hostname.
  if (/^file:\/\//i.test(value)) return value;
  // Accept a pasted Windows path as a convenience too.
  if (path.isAbsolute(value)) return pathToFileURL(value).toString();
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}
function isNavigableUrl(url) {
  try { return ['http:', 'https:', 'file:', 'about:'].includes(new URL(url).protocol) || url === HOME_URL || url === CHAT_URL; } catch { return false; }
}
function navigateTab(id, input) {
  const tab = tabs.get(id);
  const url = normaliseUrl(input);
  if (tab && isNavigableUrl(url)) tab.view.webContents.loadURL(url).catch(() => {});
}
function createTab(initialUrl = HOME_URL, activate = true) {
  const id = crypto.randomUUID();
  const view = new WebContentsView({ webPreferences: {
    preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false, nodeIntegration: false,
  } });
  const tab = { id, view, url: initialUrl, title: 'New Tab', isLoading: false };
  tabs.set(id, tab);
  view.webContents.setBackgroundThrottling(false);
  view.webContents.on('page-title-updated', (_event, title) => { tab.title = title || 'New Tab'; publishTabs(); });
  view.webContents.on('did-start-loading', () => { tab.isLoading = true; publishTabs(); });
  view.webContents.on('did-stop-loading', () => { tab.isLoading = false; publishTabs(); });
  view.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => { if (isMainFrame) automation?.invalidate(id); });
  view.webContents.on('did-navigate', (_event, url) => { gateway.destroySessionsForOwner(view.webContents.id); tab.url = url; publishTabs(); });
  view.webContents.on('did-navigate-in-page', (_event, url) => { automation?.invalidate(id); tab.url = url; publishTabs(); });
  view.webContents.on('will-navigate', (event, url) => { if (!isNavigableUrl(url)) event.preventDefault(); });
  view.webContents.setWindowOpenHandler(({ url }) => { if (isNavigableUrl(url)) createTab(url, true); return { action: 'deny' }; });
  view.webContents.on('render-process-gone', () => { tab.title = 'Page crashed'; tab.isLoading = false; publishTabs(); });
  view.webContents.on('destroyed', () => gateway.destroySessionsForOwner(view.webContents.id));
  navigateTab(id, initialUrl);
  if (activate) showTab(id); else publishTabs();
  return id;
}
function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  const wasActive = activeTabId === id;
  gateway.destroySessionsForOwner(tab.view.webContents.id);
  automation?.disposeTab(id);
  if (wasActive && mainWindow) mainWindow.contentView.removeChildView(tab.view);
  tabs.delete(id);
  tab.view.webContents.close();
  if (!tabs.size) createTab(HOME_URL); else if (wasActive) showTab(tabs.keys().next().value); else publishTabs();
}
function createWindow() {
  mainWindow = new BrowserWindow({ width: 1280, height: 860, minWidth: 760, minHeight: 480, webPreferences: {
    preload: path.join(__dirname, 'browser-preload.js'), contextIsolation: true, sandbox: false, nodeIntegration: false,
  } });
  configureMediaPermissions(session.defaultSession, () => mainWindow?.webContents || null);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'browser.html'));
  automation = new PageAutomation({ getTab: (id) => tabs.get(id) });
  browserAgent = new BrowserAgent({
    automation,
    getTabs: () => [...tabs.values()],
    getTab: (id) => tabs.get(id),
    getActiveTabId: () => activeTabId,
    createTab,
    showTab,
    closeTab,
    navigateTab,
    getWindow: () => mainWindow,
    emit: (payload) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('assistant:event', payload); },
  });
  speechService = new SpeechService({
    app,
    emit: (payload) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('assistant:event', payload); },
  });
  mainWindow.on('resize', layoutActiveTab);
  mainWindow.on('closed', () => {
    browserAgent?.cancel();
    speechService?.shutdown();
    for (const tab of tabs.values()) tab.view.webContents.close();
    tabs.clear(); activeTabId = null; browserAgent = null; speechService = null; automation = null; mainWindow = null;
  });
  mainWindow.webContents.once('did-finish-load', () => {
    createTab(HOME_URL, true);
    createTab(CUSTOMER_INTAKE_URL, false);
    createTab(CHAT_URL, false);
    createTab(DIJKSTRA_URL, false);
  });
}
function frameOrigin(event) {
  try { const url = event.senderFrame?.url || ''; return url.startsWith('file://') ? 'file://' : new URL(url).origin; } catch { return null; }
}
function isTopLevelAiEvent(event) {
  return event.senderFrame === event.sender.mainFrame &&
    (perms.isAllowed(frameOrigin(event)) || event.senderFrame?.url === HOME_URL || event.senderFrame?.url === CHAT_URL);
}

const pendingToolCalls = new Map();
function executeToolInPage(sessionId, toolName, args) {
  const ownerWebContentsId = gateway.getSessionOwner(sessionId);
  const contents = webContents.fromId(ownerWebContentsId);
  if (!contents || contents.isDestroyed()) return Promise.reject(new Error('originating tab is no longer available'));
  const callId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pendingToolCalls.delete(callId); reject(new Error(`tool "${toolName}" timed out`)); }, 30000);
    pendingToolCalls.set(callId, { resolve, reject, timeout, ownerWebContentsId });
    contents.send('ai:execute-tool', { callId, sessionId, toolName, args });
  });
}
ipcMain.on('ai:tool-result', (event, { callId, ok, result, error }) => {
  const pending = pendingToolCalls.get(callId);
  if (!pending || pending.ownerWebContentsId !== event.sender.id) return;
  pendingToolCalls.delete(callId); clearTimeout(pending.timeout);
  ok ? pending.resolve(result) : pending.reject(new Error(error || 'tool failed'));
});

ipcMain.on('ai:is-origin-allowed', (event) => { event.returnValue = isTopLevelAiEvent(event); });
ipcMain.handle('ai:availability', async (event, { tier } = {}) => {
  if (!isTopLevelAiEvent(event)) throw new Error('AI is only available to top-level web pages');
  return models.availability(tier || 'default');
});
ipcMain.handle('ai:download', async (event, { tier } = {}) => {
  if (!isTopLevelAiEvent(event)) throw new Error('AI is only available to top-level web pages');
  await models.download(tier || 'default', (progress) => event.sender.send('ai:download-progress', progress));
  return { ok: true };
});
ipcMain.handle('ai:create', async (event, { systemPrompt, tools, tier } = {}) => {
  if (!isTopLevelAiEvent(event)) throw new Error('AI is only available to top-level web pages');
  const origin = frameOrigin(event);
  if (!await perms.ensurePermission(origin, 'ai.session')) throw new Error('permission denied by user');
  const toolMeta = (tools || []).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
  return gateway.createSession({ origin, ownerWebContentsId: event.sender.id, systemPrompt, tools: toolMeta, tier });
});
ipcMain.handle('ai:prompt', async (event, { sessionId, text, options } = {}) => {
  if (!isTopLevelAiEvent(event)) throw new Error('AI is only available to top-level web pages');
  gateway.assertSessionOwner(sessionId, event.sender.id);
  return gateway.prompt(sessionId, text, options || {}, executeToolInPage);
});
ipcMain.handle('ai:prompt-stream', async (event, { sessionId, text, options, streamId } = {}) => {
  if (!isTopLevelAiEvent(event)) throw new Error('AI is only available to top-level web pages');
  gateway.assertSessionOwner(sessionId, event.sender.id);
  const channel = `ai:stream:${streamId}`;
  try {
    await gateway.promptStreaming(sessionId, text, options || {}, (token) => event.sender.send(channel, { type: 'chunk', token }));
    event.sender.send(channel, { type: 'done' });
  } catch (error) { event.sender.send(channel, { type: 'error', error: String(error.message || error) }); }
  return { ok: true };
});
ipcMain.handle('ai:files-pick', async (event) => {
  if (!isTopLevelAiEvent(event)) throw new Error('AI is only available to top-level web pages');
  const origin = frameOrigin(event);
  if (!await perms.ensurePermission(origin, 'ai.files')) throw new Error('file permission denied');
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'Text', extensions: ['txt', 'md', 'json', 'csv', 'log'] }] });
  if (canceled || !filePaths.length) return null;
  const fs = require('fs'); const filePath = filePaths[0];
  return { name: path.basename(filePath), mime: 'text/plain', text: fs.readFileSync(filePath, 'utf8').slice(0, 200000) };
});
ipcMain.handle('ai:destroy', async (event, { sessionId } = {}) => {
  gateway.assertSessionOwner(sessionId, event.sender.id); gateway.destroySession(sessionId); return { ok: true };
});

ipcMain.handle('browser:new-tab', () => createTab());
ipcMain.handle('browser:activate-tab', (_event, id) => showTab(id));
ipcMain.handle('browser:close-tab', (_event, id) => closeTab(id));
ipcMain.handle('browser:navigate', (_event, id, url) => navigateTab(id, url));
ipcMain.handle('browser:back', (_event, id) => { const tab = tabs.get(id); if (tab?.view.webContents.canGoBack()) tab.view.webContents.goBack(); });
ipcMain.handle('browser:forward', (_event, id) => { const tab = tabs.get(id); if (tab?.view.webContents.canGoForward()) tab.view.webContents.goForward(); });
ipcMain.handle('browser:reload', (_event, id) => tabs.get(id)?.view.webContents.reload());
ipcMain.handle('browser:set-sidebar', (event, open) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('browser chrome only');
  sidebarOpen = !!open; layoutActiveTab(); return { sidebarOpen };
});

function assertBrowserChrome(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('browser assistant is only available to browser chrome');
}
ipcMain.handle('assistant:get-state', async (event) => {
  assertBrowserChrome(event);
  return { ...browserAgent.state(), model: await browserAgent.modelState() };
});
ipcMain.handle('assistant:send', async (event, text) => { assertBrowserChrome(event); return browserAgent.send(text); });
ipcMain.handle('assistant:cancel', async (event) => { assertBrowserChrome(event); return browserAgent.cancel(); });
ipcMain.handle('assistant:clear', async (event) => { assertBrowserChrome(event); return browserAgent.clear(); });
ipcMain.handle('assistant:approve', async (event, id) => { assertBrowserChrome(event); return browserAgent.approve(id); });
ipcMain.handle('assistant:reject', async (event, id) => { assertBrowserChrome(event); return browserAgent.reject(id); });
ipcMain.handle('assistant:download-model', async (event) => { assertBrowserChrome(event); return browserAgent.downloadModel(); });
ipcMain.handle('assistant:get-speech-state', async (event) => {
  assertBrowserChrome(event); return speechService.getState();
});
ipcMain.handle('assistant:download-speech-model', async (event) => {
  assertBrowserChrome(event);
  return speechService.downloadModel();
});
ipcMain.handle('assistant:transcribe-audio', async (event, payload) => {
  assertBrowserChrome(event); return speechService.transcribe(payload);
});
ipcMain.handle('assistant:cancel-transcription', async (event) => {
  assertBrowserChrome(event); return speechService.cancelTranscription();
});

app.whenReady().then(() => {
  startSidecar(); createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { speechService?.shutdown(); stopSidecar(); });
