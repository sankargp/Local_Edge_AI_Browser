'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { SpeechService } = require('../src/speech');
const { encodePcm16Wav } = require('../renderer/voice-audio');

async function fixture(t, overrides = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'speech-test-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const binaryPath = path.join(root, 'whisper-cli.exe');
  await fsp.writeFile(binaryPath, 'fixture');
  const modelBytes = Buffer.from('fixture-model');
  const config = {
    engine: { platform: 'win32', arch: 'x64', binary: 'unused' },
    model: {
      id: 'test-model', filename: 'model.bin', language: 'en', sizeBytes: modelBytes.length,
      url: 'https://models.invalid/model.bin', sha256: crypto.createHash('sha256').update(modelBytes).digest('hex'),
    },
    limits: { maxDurationMs: 120000, transcriptionTimeoutMs: 1000, maxTranscriptCharacters: 20000 },
  };
  const service = new SpeechService({
    userDataPath: root, appRoot: root, tempRoot: root, binaryPath, platform: 'win32', arch: 'x64', config,
    ...overrides,
  });
  return { root, service, modelBytes, config };
}

test('speech state distinguishes missing model, ready, and unsupported runtime', async (t) => {
  const { service } = await fixture(t);
  assert.equal((await service.getState()).state, 'model-required');
  await fsp.mkdir(service.modelDirectory, { recursive: true });
  await fsp.writeFile(service.modelPath, 'fixture-model');
  assert.equal((await service.getState()).state, 'ready');
  service.platform = 'linux';
  assert.equal((await service.getState()).state, 'unavailable');
});

test('speech model download verifies content and atomically installs it', async (t) => {
  const base = await fixture(t);
  base.service.fetch = async () => new Response(base.modelBytes, { status: 200 });
  const progress = [];
  const state = await base.service.downloadModel((item) => progress.push(item));
  assert.equal(state.state, 'ready');
  assert.deepEqual(await fsp.readFile(base.service.modelPath), base.modelBytes);
  assert.ok(progress.length > 0);
  assert.equal(fs.existsSync(`${base.service.modelPath}.part`), false);
});

test('speech model checksum failures remove partial downloads', async (t) => {
  const base = await fixture(t);
  base.service.fetch = async () => new Response(Buffer.from('wrong-content'), { status: 200 });
  await assert.rejects(base.service.downloadModel(), /checksum|size/);
  assert.equal(fs.existsSync(base.service.modelPath), false);
  assert.equal(fs.existsSync(`${base.service.modelPath}.part`), false);
});

test('speech transcription uses one local process and removes temporary audio', async (t) => {
  let tempDirectory;
  const spawnFn = (_binary, args) => {
    const proc = new EventEmitter(); proc.stderr = new EventEmitter(); proc.kill = () => proc.emit('close', null);
    const outputBase = args[args.indexOf('-of') + 1]; tempDirectory = path.dirname(outputBase);
    setImmediate(async () => { await fsp.writeFile(`${outputBase}.txt`, '  local transcript  '); proc.emit('close', 0); });
    return proc;
  };
  const base = await fixture(t, { spawnFn });
  await fsp.mkdir(base.service.modelDirectory, { recursive: true });
  await fsp.writeFile(base.service.modelPath, base.modelBytes);
  const wav = encodePcm16Wav(new Float32Array(1600));
  assert.deepEqual(await base.service.transcribe({ wav, durationMs: 100 }), { text: 'local transcript' });
  assert.equal(fs.existsSync(tempDirectory), false);
});

test('speech cancellation terminates the active process', async (t) => {
  let proc;
  const spawnFn = () => {
    proc = new EventEmitter(); proc.stderr = new EventEmitter();
    proc.kill = () => setImmediate(() => proc.emit('close', null));
    return proc;
  };
  const base = await fixture(t, { spawnFn });
  await fsp.mkdir(base.service.modelDirectory, { recursive: true });
  await fsp.writeFile(base.service.modelPath, base.modelBytes);
  const promise = base.service.transcribe({ wav: encodePcm16Wav(new Float32Array(1600)), durationMs: 100 });
  while (!base.service.currentJob) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(base.service.cancelTranscription(), { cancelled: true });
  await assert.rejects(promise, { name: 'AbortError' });
  assert.equal(base.service.currentJob, null);
});

test('speech rejects concurrent jobs and enforces the process timeout', async (t) => {
  let proc;
  const baseConfig = (await fixture(t)).config;
  const config = { ...baseConfig, limits: { ...baseConfig.limits, transcriptionTimeoutMs: 20 } };
  const spawnFn = () => {
    proc = new EventEmitter(); proc.stderr = new EventEmitter();
    proc.kill = () => setImmediate(() => proc.emit('close', null));
    return proc;
  };
  const isolated = await fixture(t, { spawnFn, config });
  await fsp.mkdir(isolated.service.modelDirectory, { recursive: true });
  await fsp.writeFile(isolated.service.modelPath, isolated.modelBytes);
  const audio = { wav: encodePcm16Wav(new Float32Array(1600)), durationMs: 100 };
  const first = isolated.service.transcribe(audio);
  while (!isolated.service.currentJob) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(isolated.service.transcribe(audio), /already in progress/);
  await assert.rejects(first, /timed out/);
  assert.equal(isolated.service.currentJob, null);
});

test('speech surfaces spawn failures without leaving temporary input', async (t) => {
  const base = await fixture(t, { spawnFn: () => { throw new Error('fixture spawn failure'); } });
  await fsp.mkdir(base.service.modelDirectory, { recursive: true });
  await fsp.writeFile(base.service.modelPath, base.modelBytes);
  await assert.rejects(
    base.service.transcribe({ wav: encodePcm16Wav(new Float32Array(1600)), durationMs: 100 }),
    /Unable to start offline transcription/
  );
  const leftovers = (await fsp.readdir(base.root)).filter((name) => name.startsWith('local-ai-speech-'));
  assert.deepEqual(leftovers, []);
});
