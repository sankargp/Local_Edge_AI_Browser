'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isBrowserChromeAudioRequest, isBrowserChromeAudioCheck } = require('../src/media-permissions');

test('only browser chrome receives audio-only media permission', () => {
  const chrome = { id: 1 };
  const page = { id: 2 };
  assert.equal(isBrowserChromeAudioRequest(chrome, chrome, 'media', { mediaTypes: ['audio'] }), true);
  assert.equal(isBrowserChromeAudioRequest(chrome, chrome, 'media', { mediaTypes: ['video'] }), false);
  assert.equal(isBrowserChromeAudioRequest(chrome, chrome, 'media', { mediaTypes: ['audio', 'video'] }), false);
  assert.equal(isBrowserChromeAudioRequest(chrome, page, 'media', { mediaTypes: ['audio'] }), false);
  assert.equal(isBrowserChromeAudioRequest(chrome, chrome, 'geolocation', {}), false);
});

test('permission checks reject pages, video, and subframes', () => {
  const chrome = { id: 1 };
  assert.equal(isBrowserChromeAudioCheck(chrome, chrome, 'media', { mediaType: 'audio', isMainFrame: true }), true);
  assert.equal(isBrowserChromeAudioCheck(chrome, chrome, 'media', { mediaType: 'video', isMainFrame: true }), false);
  assert.equal(isBrowserChromeAudioCheck(chrome, chrome, 'media', { mediaType: 'audio', isMainFrame: false }), false);
  assert.equal(isBrowserChromeAudioCheck(chrome, { id: 2 }, 'media', { mediaType: 'audio', isMainFrame: true }), false);
});
