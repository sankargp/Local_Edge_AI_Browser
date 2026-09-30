'use strict';

(function exposeVoiceAudio(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.voiceAudio = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const OUTPUT_SAMPLE_RATE = 16000;

  function downmixChannels(channels) {
    if (!Array.isArray(channels) || !channels.length) return new Float32Array();
    const length = Math.min(...channels.map((channel) => channel.length));
    const mono = new Float32Array(length);
    for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
      const channel = channels[channelIndex];
      for (let i = 0; i < length; i += 1) mono[i] += channel[i] / channels.length;
    }
    return mono;
  }

  function resampleLinear(samples, inputRate, outputRate = OUTPUT_SAMPLE_RATE) {
    if (!(samples instanceof Float32Array)) samples = Float32Array.from(samples || []);
    if (!Number.isFinite(inputRate) || inputRate <= 0 || !Number.isFinite(outputRate) || outputRate <= 0) {
      throw new TypeError('sample rates must be positive numbers');
    }
    if (!samples.length || inputRate === outputRate) return new Float32Array(samples);
    const outputLength = Math.max(1, Math.round(samples.length * outputRate / inputRate));
    const output = new Float32Array(outputLength);
    const scale = inputRate / outputRate;
    for (let i = 0; i < outputLength; i += 1) {
      const position = i * scale;
      const left = Math.min(samples.length - 1, Math.floor(position));
      const right = Math.min(samples.length - 1, left + 1);
      const fraction = position - left;
      output[i] = samples[left] + ((samples[right] - samples[left]) * fraction);
    }
    return output;
  }

  function encodePcm16Wav(samples, sampleRate = OUTPUT_SAMPLE_RATE) {
    if (!(samples instanceof Float32Array)) samples = Float32Array.from(samples || []);
    const buffer = new ArrayBuffer(44 + (samples.length * 2));
    const view = new DataView(buffer);
    const writeText = (offset, value) => {
      for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
    };
    writeText(0, 'RIFF');
    view.setUint32(4, 36 + (samples.length * 2), true);
    writeText(8, 'WAVE');
    writeText(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeText(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i += 1) {
      const clamped = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + (i * 2), clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    }
    return buffer;
  }

  async function wavFromBlob(blob, AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext, maxDurationMs = 120000) {
    if (!AudioContextClass) throw new Error('Audio decoding is unavailable in this browser');
    const context = new AudioContextClass();
    try {
      const encoded = await blob.arrayBuffer();
      const decoded = await context.decodeAudioData(encoded.slice(0));
      const channels = [];
      for (let i = 0; i < decoded.numberOfChannels; i += 1) channels.push(decoded.getChannelData(i));
      const mono = downmixChannels(channels);
      const resampled = resampleLinear(mono, decoded.sampleRate, OUTPUT_SAMPLE_RATE);
      const maxSamples = Math.floor(OUTPUT_SAMPLE_RATE * maxDurationMs / 1000);
      const bounded = resampled.length > maxSamples ? resampled.slice(0, maxSamples) : resampled;
      return { wav: encodePcm16Wav(bounded), durationMs: Math.round(bounded.length / OUTPUT_SAMPLE_RATE * 1000) };
    } finally {
      if (typeof context.close === 'function') await context.close().catch(() => {});
    }
  }

  function insertTranscript(value, selectionStart, selectionEnd, transcript) {
    const original = String(value || '');
    const clean = String(transcript || '').trim();
    const start = Math.max(0, Math.min(original.length, Number.isInteger(selectionStart) ? selectionStart : original.length));
    const end = Math.max(start, Math.min(original.length, Number.isInteger(selectionEnd) ? selectionEnd : start));
    if (!clean) return { value: original, selectionStart: start, selectionEnd: end };
    const left = original.slice(0, start);
    const right = original.slice(end);
    const before = left && !/\s$/.test(left) ? ' ' : '';
    const after = right && !/^\s/.test(right) ? ' ' : '';
    const inserted = `${before}${clean}${after}`;
    const caret = left.length + before.length + clean.length;
    return { value: `${left}${inserted}${right}`, selectionStart: caret, selectionEnd: caret };
  }

  return { OUTPUT_SAMPLE_RATE, downmixChannels, resampleLinear, encodePcm16Wav, wavFromBlob, insertTranscript };
});
