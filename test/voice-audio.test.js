'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { downmixChannels, resampleLinear, encodePcm16Wav, insertTranscript } = require('../renderer/voice-audio');
const { validateWav } = require('../src/speech');

test('voice audio downmixes channels and resamples to 16 kHz', () => {
  const mono = downmixChannels([Float32Array.from([1, -1]), Float32Array.from([-1, 1])]);
  assert.deepEqual([...mono], [0, 0]);
  const source = Float32Array.from({ length: 48000 }, (_value, index) => index / 48000);
  const output = resampleLinear(source, 48000, 16000);
  assert.equal(output.length, 16000);
  assert.ok(Math.abs(output[8000] - 0.5) < 0.001);
});

test('voice audio emits a valid bounded PCM16 WAV', () => {
  const wav = encodePcm16Wav(Float32Array.from({ length: 16000 }, () => 0.25));
  const validated = validateWav(wav, 1000, 120000);
  assert.equal(validated.durationMs, 1000);
  assert.equal(Buffer.from(wav).toString('ascii', 0, 4), 'RIFF');
  assert.throws(() => validateWav(wav, 5000, 120000), /duration metadata/);
  assert.throws(() => validateWav(new Uint8Array(44), 0, 120000), /standard PCM/);
});

test('transcripts insert at selections without destroying drafts', () => {
  assert.deepEqual(insertTranscript('world', 0, 0, 'hello'), { value: 'hello world', selectionStart: 5, selectionEnd: 5 });
  assert.deepEqual(insertTranscript('hello world', 6, 11, 'there'), { value: 'hello there', selectionStart: 11, selectionEnd: 11 });
  assert.deepEqual(insertTranscript('hello', 5, 5, 'world'), { value: 'hello world', selectionStart: 11, selectionEnd: 11 });
  assert.deepEqual(insertTranscript('draft', 2, 4, '   '), { value: 'draft', selectionStart: 2, selectionEnd: 4 });
});
