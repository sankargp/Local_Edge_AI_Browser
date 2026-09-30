'use strict';

const MAX_RESULT_CHARS = 60000;
const CONSEQUENCE_WORDS = /\b(submit|send|publish|post|purchase|buy|pay|order|book|reserve|confirm|delete|remove|destroy|cancel subscription|sign out|log out|download|upload)\b/i;

function assertSafeUrl(input, { allowFile = true } = {}) {
  let url;
  try { url = new URL(String(input || '').trim()); } catch { throw new Error('invalid URL'); }
  const allowed = allowFile ? ['http:', 'https:', 'file:', 'about:'] : ['http:', 'https:'];
  if (!allowed.includes(url.protocol)) throw new Error(`URL scheme ${url.protocol} is not allowed`);
  if (url.protocol === 'about:' && url.href !== 'about:blank') throw new Error('only about:blank is allowed');
  return url.href;
}

function capResult(value, maxChars = MAX_RESULT_CHARS) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= maxChars) return value;
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} characters]`;
}

function targetSummary(target = {}) {
  return [target.role, target.tag, target.name, target.text, target.type, target.href]
    .filter(Boolean).join(' ').slice(0, 500);
}

function classifyConsequence(toolName, args = {}, target = {}) {
  if (['download_resource', 'upload_file', 'close_tab'].includes(toolName)) {
    return { required: true, effect: toolName.replaceAll('_', ' ') };
  }
  if (toolName === 'press_key' && String(args.key || '').toLowerCase() === 'enter') {
    return { required: true, effect: 'Press Enter, which may submit the current form' };
  }
  if (toolName !== 'click_element') return { required: false, effect: null };

  const summary = targetSummary(target);
  const type = String(target.type || '').toLowerCase();
  const href = String(target.href || '');
  const explicitSubmit = type === 'submit' || target.formAction || target.download;
  const externalProtocol = href && !/^(https?:|file:|about:|#|\/)/i.test(href);
  if (explicitSubmit || externalProtocol || CONSEQUENCE_WORDS.test(summary)) {
    return { required: true, effect: `Activate ${summary || 'a consequential control'}` };
  }
  return { required: false, effect: null };
}

function requireString(args, field, maxLength = 10000) {
  const value = args && args[field];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  if (value.length > maxLength) throw new Error(`${field} is too long`);
  return value;
}

function requireTabId(args) { return requireString(args, 'tabId', 100); }
function requireRef(args) { return requireString(args, 'ref', 100); }

module.exports = {
  MAX_RESULT_CHARS,
  assertSafeUrl,
  capResult,
  classifyConsequence,
  requireString,
  requireTabId,
  requireRef,
  targetSummary,
};
