'use strict';

const { dialog, BrowserWindow } = require('electron');

// Every top-level web origin can request local AI. Grants last for this app session.
const grants = new Map();
const allowedOrigins = ['http://*', 'https://*'];

function isAllowed(origin) {
  return origin === 'file://' || (typeof origin === 'string' && /^https?:\/\//i.test(origin));
}
function hasGrant(origin, capability) { return grants.get(origin)?.has(capability) || false; }
function recordGrant(origin, capability) {
  if (!grants.has(origin)) grants.set(origin, new Set());
  grants.get(origin).add(capability);
}
const CAPABILITY_COPY = {
  'ai.session': (origin) => `${origin} wants to run AI on your local model and process data it supplies.`,
  'ai.files': (origin) => `${origin} wants to open a local file and use it as AI context.`,
};
async function ensurePermission(origin, capability) {
  if (!isAllowed(origin)) return false;
  if (hasGrant(origin, capability)) return true;
  const detail = (CAPABILITY_COPY[capability] || ((value) => `${value} is requesting a local AI capability.`))(origin);
  const { response, checkboxChecked } = await dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
    type: 'question', buttons: ['Allow', 'Block'], defaultId: 0, cancelId: 1,
    title: 'Local AI permission', message: 'Allow local AI access?',
    detail: `${detail}\n\nInference stays on this device.`,
    checkboxLabel: 'Remember for this site', checkboxChecked: true, noLink: true,
  });
  const allow = response === 0;
  if (allow && checkboxChecked) recordGrant(origin, capability);
  return allow;
}

module.exports = { isAllowed, hasGrant, ensurePermission, allowedOrigins };
