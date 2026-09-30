'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const { configureMediaPermissions } = require('../src/media-permissions');

app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');

function waitFor(window, expression, timeoutMs = 15000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = async () => {
      try {
        if (await window.webContents.executeJavaScript(expression)) return resolve();
      } catch { /* renderer may still be loading */ }
      if (Date.now() - started >= timeoutMs) return reject(new Error(`Timed out waiting for: ${expression}`));
      setTimeout(check, 50);
    };
    check();
  });
}

app.whenReady().then(async () => {
  let window;
  let pageWindow;
  let sendCount = 0;
  try {
    window = new BrowserWindow({ show: false, webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'browser-preload.js'), contextIsolation: true, sandbox: false, nodeIntegration: false,
    } });
    window.webContents.setBackgroundThrottling(false);
    configureMediaPermissions(session.defaultSession, () => window.webContents);

    const noOp = async () => ({ ok: true });
    for (const channel of ['browser:new-tab', 'browser:activate-tab', 'browser:close-tab', 'browser:navigate', 'browser:back', 'browser:forward', 'browser:reload', 'browser:set-sidebar']) ipcMain.handle(channel, noOp);
    ipcMain.handle('assistant:get-state', async () => ({ busy: false, model: { state: 'available', model: 'fixture' } }));
    ipcMain.handle('assistant:get-speech-state', async () => ({ state: 'ready', model: 'fixture-speech', sizeBytes: 1 }));
    ipcMain.handle('assistant:transcribe-audio', async (_event, audio) => {
      assert.ok(audio.wav instanceof ArrayBuffer || ArrayBuffer.isView(audio.wav));
      assert.ok(audio.durationMs > 0); return { text: 'voice fixture' };
    });
    ipcMain.handle('assistant:cancel-transcription', noOp);
    ipcMain.handle('assistant:send', async () => { sendCount += 1; return { ok: true }; });
    for (const channel of ['assistant:cancel', 'assistant:clear', 'assistant:approve', 'assistant:reject', 'assistant:download-model', 'assistant:download-speech-model']) ipcMain.handle(channel, noOp);

    await window.loadFile(path.join(__dirname, '..', 'renderer', 'browser.html'), { query: { voiceMaxMs: '1200' } });
    await waitFor(window, `document.querySelector('#mic') && !document.querySelector('#mic').disabled`);
    await window.webContents.executeJavaScript(`(() => { const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = async (...args) => { const stream = await original(...args); window.__voiceTestStream = stream; return stream; }; })()`);

    await window.webContents.executeJavaScript(`document.querySelector('#mic').click()`);
    await waitFor(window, `document.body.dataset.voiceState === 'recording'`);
    await waitFor(window, `document.body.dataset.voiceState === 'idle' && document.querySelector('#agent-prompt').value.includes('voice fixture')`, 30000);
    assert.equal(sendCount, 0, 'voice transcription must not auto-send');
    assert.equal(await window.webContents.executeJavaScript(`window.__voiceTestStream.getTracks().every(track => track.readyState === 'ended')`), true);

    const beforeCancel = await window.webContents.executeJavaScript(`document.querySelector('#agent-prompt').value`);
    await window.webContents.executeJavaScript(`document.querySelector('#mic').click()`);
    await waitFor(window, `document.body.dataset.voiceState === 'recording'`);
    await window.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await waitFor(window, `document.body.dataset.voiceState === 'idle'`);
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#agent-prompt').value`), beforeCancel);
    assert.equal(await window.webContents.executeJavaScript(`window.__voiceTestStream.getTracks().every(track => track.readyState === 'ended')`), true);

    pageWindow = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    await pageWindow.loadFile(path.join(__dirname, '..', 'renderer', 'customer-intake-demo.html'));
    const pageMicrophoneDenied = await pageWindow.webContents.executeJavaScript(`navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => { stream.getTracks().forEach(track => track.stop()); return false; }, () => true)`);
    assert.equal(pageMicrophoneDenied, true, 'visited pages must not receive microphone access');

    console.log('Electron voice recording smoke test passed.');
  } catch (error) {
    console.error(error); process.exitCode = 1;
  } finally {
    pageWindow?.destroy();
    window?.destroy(); app.exit(process.exitCode || 0);
  }
});
