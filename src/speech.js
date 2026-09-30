'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const DEFAULT_CONFIG = require('../config/speech.json');

function abortError(message = 'Transcription cancelled') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('wav must be an ArrayBuffer or typed array');
}

function validateWav(value, suppliedDurationMs, maxDurationMs) {
  const wav = toBuffer(value);
  const maxBytes = 44 + Math.ceil(maxDurationMs / 1000 * 16000 * 2);
  if (wav.length < 44 || wav.length > maxBytes) throw new Error('audio exceeds the allowed size');
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE' ||
      wav.toString('ascii', 12, 16) !== 'fmt ' || wav.toString('ascii', 36, 40) !== 'data') {
    throw new Error('audio must be a standard PCM WAV file');
  }
  const audioFormat = wav.readUInt16LE(20);
  const channels = wav.readUInt16LE(22);
  const sampleRate = wav.readUInt32LE(24);
  const bitsPerSample = wav.readUInt16LE(34);
  const dataBytes = wav.readUInt32LE(40);
  if (audioFormat !== 1 || channels !== 1 || sampleRate !== 16000 || bitsPerSample !== 16) {
    throw new Error('audio must be 16 kHz mono PCM16 WAV');
  }
  if (dataBytes !== wav.length - 44 || dataBytes % 2) throw new Error('audio WAV length is invalid');
  const durationMs = Math.round(dataBytes / (sampleRate * channels * (bitsPerSample / 8)) * 1000);
  if (!Number.isFinite(suppliedDurationMs) || suppliedDurationMs < 0 || Math.abs(suppliedDurationMs - durationMs) > 1000) {
    throw new Error('audio duration metadata is invalid');
  }
  if (durationMs > maxDurationMs) throw new Error('recording exceeds the two-minute limit');
  return { wav, durationMs };
}

class SpeechService {
  constructor(options = {}) {
    if (!options.app && (!options.userDataPath || !options.appRoot)) throw new Error('app or explicit paths are required');
    this.config = options.config || DEFAULT_CONFIG;
    this.userDataPath = options.userDataPath || options.app.getPath('userData');
    this.appRoot = options.appRoot || options.app.getAppPath();
    this.tempRoot = options.tempRoot || os.tmpdir();
    this.platform = options.platform || process.platform;
    this.arch = options.arch || process.arch;
    this.spawn = options.spawnFn || spawn;
    this.fetch = options.fetchFn || globalThis.fetch;
    this.emit = options.emit || (() => {});
    const packagedRelativePath = this.config.engine.binary.replace(/^resources[\\/]/, '');
    const developmentOverride = options.app?.isPackaged ? null : process.env.WHISPER_CPP_PATH;
    this.binaryPath = options.binaryPath || developmentOverride ||
      (options.app?.isPackaged
        ? path.join(options.resourcesPath || process.resourcesPath, packagedRelativePath)
        : path.join(this.appRoot, this.config.engine.binary));
    this.runtimeFiles = this.config.engine.files || [path.basename(this.binaryPath)];
    this.modelDirectory = path.join(this.userDataPath, 'speech-models');
    this.modelPath = path.join(this.modelDirectory, this.config.model.filename);
    this.downloading = false;
    this.currentJob = null;
    this.downloadAbort = null;
  }

  async getState() {
    const base = { model: this.config.model.id, sizeBytes: this.config.model.sizeBytes };
    if (this.platform !== this.config.engine.platform || this.arch !== this.config.engine.arch) {
      return { ...base, state: 'unavailable', reason: 'Offline speech currently requires Windows x64.' };
    }
    const runtimeDirectory = path.dirname(this.binaryPath);
    if (this.runtimeFiles.some((filename) => !fs.existsSync(path.join(runtimeDirectory, filename)))) {
      return { ...base, state: 'unavailable', reason: 'The packaged Whisper runtime is missing.' };
    }
    if (this.downloading) return { ...base, state: 'downloading' };
    if (this.currentJob) return { ...base, state: 'transcribing' };
    if (!fs.existsSync(this.modelPath)) return { ...base, state: 'model-required' };
    return { ...base, state: 'ready' };
  }

  async downloadModel(onProgress) {
    if (this.downloading) throw new Error('speech model download is already in progress');
    if (this.platform !== this.config.engine.platform || this.arch !== this.config.engine.arch) {
      throw new Error('offline speech is unavailable on this platform');
    }
    if (typeof this.fetch !== 'function') throw new Error('model download is unavailable');
    await fsp.mkdir(this.modelDirectory, { recursive: true });
    const partialPath = `${this.modelPath}.part`;
    this.downloading = true;
    this.downloadAbort = new AbortController();
    this.emit({ type: 'speech-state', state: await this.getState() });
    let handle;
    try {
      const response = await this.fetch(this.config.model.url, { signal: this.downloadAbort.signal, redirect: 'follow' });
      if (!response.ok || !response.body) throw new Error(`speech model download failed (${response.status})`);
      handle = await fsp.open(partialPath, 'w');
      const hash = crypto.createHash('sha256');
      const reader = response.body.getReader();
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        received += chunk.length;
        if (received > this.config.model.sizeBytes + 1024) throw new Error('speech model download exceeded expected size');
        hash.update(chunk);
        await handle.write(chunk);
        const progress = { received, total: this.config.model.sizeBytes };
        onProgress?.(progress);
        this.emit({ type: 'speech-model-progress', progress });
      }
      await handle.close(); handle = null;
      if (received !== this.config.model.sizeBytes) throw new Error('speech model download size did not match');
      if (hash.digest('hex').toLowerCase() !== this.config.model.sha256.toLowerCase()) {
        throw new Error('speech model checksum verification failed');
      }
      await fsp.rm(this.modelPath, { force: true });
      await fsp.rename(partialPath, this.modelPath);
      this.downloading = false;
      return await this.getState();
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fsp.rm(partialPath, { force: true }).catch(() => {});
      this.downloading = false;
      this.downloadAbort = null;
      this.emit({ type: 'speech-state', state: await this.getState() });
    }
  }

  async transcribe({ wav, durationMs } = {}) {
    if (this.currentJob) throw new Error('a transcription is already in progress');
    const state = await this.getState();
    if (state.state !== 'ready') throw new Error(state.reason || 'speech model is not ready');
    const validated = validateWav(wav, durationMs, this.config.limits.maxDurationMs);
    const directory = await fsp.mkdtemp(path.join(this.tempRoot, 'local-ai-speech-'));
    const inputPath = path.join(directory, 'recording.wav');
    const outputBase = path.join(directory, 'transcript');
    await fsp.writeFile(inputPath, validated.wav, { flag: 'wx' });
    try {
      const text = await this.runWhisper(inputPath, outputBase);
      return { text: text.trim().slice(0, this.config.limits.maxTranscriptCharacters) };
    } finally {
      await fsp.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  runWhisper(inputPath, outputBase) {
    return new Promise((resolve, reject) => {
      const args = ['-m', this.modelPath, '-f', inputPath, '-l', 'en', '-otxt', '-of', outputBase, '-np', '-nt', '-ng'];
      let settled = false;
      let stderr = '';
      let timeout = null;
      let proc;
      try {
        proc = this.spawn(this.binaryPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (error) {
        reject(new Error(`Unable to start offline transcription: ${error.message}`)); return;
      }
      const job = { proc, cancelled: false };
      this.currentJob = job;
      this.emit({ type: 'speech-state', state: { state: 'transcribing', model: this.config.model.id, sizeBytes: this.config.model.sizeBytes } });
      const finish = (error, text) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (this.currentJob === job) this.currentJob = null;
        this.getState().then((state) => this.emit({ type: 'speech-state', state })).catch(() => {});
        error ? reject(error) : resolve(text);
      };
      proc.stderr?.on('data', (chunk) => { if (stderr.length < 4096) stderr += String(chunk).slice(0, 4096 - stderr.length); });
      proc.once('error', (error) => finish(new Error(`Offline transcription failed to start: ${error.message}`)));
      proc.once('close', async (code) => {
        if (job.cancelled) return finish(abortError());
        if (code !== 0) return finish(new Error(`Offline transcription failed${stderr.trim() ? `: ${stderr.trim()}` : ` (exit ${code})`}`));
        try { finish(null, await fsp.readFile(`${outputBase}.txt`, 'utf8')); }
        catch { finish(new Error('Offline transcription produced no output')); }
      });
      timeout = setTimeout(() => {
        job.cancelled = true;
        try { proc.kill(); } catch { /* process already exited */ }
        finish(new Error('Offline transcription timed out'));
      }, this.config.limits.transcriptionTimeoutMs);
    });
  }

  cancelTranscription() {
    if (!this.currentJob) return { cancelled: false };
    this.currentJob.cancelled = true;
    try { this.currentJob.proc.kill(); } catch { /* process already exited */ }
    return { cancelled: true };
  }

  shutdown() {
    this.downloadAbort?.abort();
    this.cancelTranscription();
  }
}

module.exports = { SpeechService, validateWav, toBuffer, abortError };
