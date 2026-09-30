'use strict';

/**
 * Capability probe + model auto-detect/download.
 *
 * - Detects NVIDIA GPU + free VRAM via `nvidia-smi` for display/telemetry.
 * - Checks whether the required model is already present in the sidecar.
 * - Exposes availability() states: available | downloadable | downloading | unavailable.
 */

const { execFile } = require('child_process');
const ollama = require('./ollama');
const MODELS = require('../config/models.json');

let downloading = false;

/** Returns { hasGpu, freeVramGB, name } using nvidia-smi. */
function probeGpu() {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=name,memory.free', '--format=csv,noheader,nounits'],
      { timeout: 5000 },
      (err, stdout) => {
        if (err || !stdout) return resolve({ hasGpu: false, freeVramGB: 0, name: null });
        // e.g. "NVIDIA GeForce RTX 4090, 23980"
        const line = stdout.trim().split('\n')[0] || '';
        const parts = line.split(',').map((s) => s.trim());
        const name = parts[0] || null;
        const freeMiB = parseInt(parts[1], 10) || 0;
        resolve({ hasGpu: true, freeVramGB: +(freeMiB / 1024).toFixed(1), name });
      }
    );
  });
}

/**
 * Availability for a given tier ('default' | 'fast').
 * Returns { state, model, gpu, reason }.
 */
async function availability(tier = 'default') {
  const spec = MODELS[tier] || MODELS.default;
  const gpu = await probeGpu();
  const up = await ollama.ping();

  if (!up) return { state: 'unavailable', model: spec.id, gpu, reason: 'inference sidecar not running' };
  if (downloading) return { state: 'downloading', model: spec.id, gpu, reason: 'model download in progress' };

  const present = (await ollama.listModels()).some((m) => m === spec.id || m.startsWith(spec.id.split(':')[0]));
  if (present) {
    // Ollama can split a model between GPU VRAM and system RAM/CPU.  VRAM is
    // therefore a useful status signal, not a reliable admission constraint.
    return { state: 'available', model: spec.id, gpu, reason: null };
  }

  return { state: 'downloadable', model: spec.id, gpu, reason: null };
}

/** Download the tier's model, streaming progress via onProgress. */
async function download(tier, onProgress) {
  const spec = MODELS[tier] || MODELS.default;
  downloading = true;
  try {
    await ollama.pullModel(spec.id, onProgress);
  } finally {
    downloading = false;
  }
  return spec.id;
}

module.exports = { probeGpu, availability, download };
