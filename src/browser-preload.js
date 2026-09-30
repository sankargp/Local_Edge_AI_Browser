'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('browser', {
  newTab: () => ipcRenderer.invoke('browser:new-tab'),
  activateTab: (id) => ipcRenderer.invoke('browser:activate-tab', id),
  closeTab: (id) => ipcRenderer.invoke('browser:close-tab', id),
  navigate: (id, url) => ipcRenderer.invoke('browser:navigate', id, url),
  back: (id) => ipcRenderer.invoke('browser:back', id),
  forward: (id) => ipcRenderer.invoke('browser:forward', id),
  reload: (id) => ipcRenderer.invoke('browser:reload', id),
  setSidebar: (open) => ipcRenderer.invoke('browser:set-sidebar', open),
  onTabs: (callback) => ipcRenderer.on('browser:tabs', (_event, state) => callback(state)),
  onLayout: (callback) => ipcRenderer.on('browser:layout', (_event, state) => callback(state)),
});

contextBridge.exposeInMainWorld('assistant', {
  getState: () => ipcRenderer.invoke('assistant:get-state'),
  send: (text) => ipcRenderer.invoke('assistant:send', text),
  cancel: () => ipcRenderer.invoke('assistant:cancel'),
  clear: () => ipcRenderer.invoke('assistant:clear'),
  approve: (id) => ipcRenderer.invoke('assistant:approve', id),
  reject: (id) => ipcRenderer.invoke('assistant:reject', id),
  downloadModel: () => ipcRenderer.invoke('assistant:download-model'),
  getSpeechState: () => ipcRenderer.invoke('assistant:get-speech-state'),
  downloadSpeechModel: () => ipcRenderer.invoke('assistant:download-speech-model'),
  transcribeAudio: (payload) => ipcRenderer.invoke('assistant:transcribe-audio', payload),
  cancelTranscription: () => ipcRenderer.invoke('assistant:cancel-transcription'),
  onEvent: (callback) => ipcRenderer.on('assistant:event', (_event, payload) => callback(payload)),
});
