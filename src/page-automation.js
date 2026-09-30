'use strict';

const crypto = require('crypto');
const { capResult } = require('./agent-policy');

const INTERACTIVE_ROLES = new Set([
  'button', 'checkbox', 'combobox', 'dialog', 'form', 'image', 'link', 'listbox',
  'menuitem', 'option', 'radio', 'searchbox', 'slider', 'spinbutton', 'switch',
  'tab', 'textbox', 'treeitem',
]);
const DETAIL_ROLES = new Set(['button', 'checkbox', 'combobox', 'image', 'link', 'radio', 'searchbox', 'switch', 'textbox']);
const MAX_AX_NODES = 500;
const MAX_REFS = 180;

function axValue(value) { return value && Object.prototype.hasOwnProperty.call(value, 'value') ? value.value : undefined; }
function clean(value, max = 500) { return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max); }

class PageAutomation {
  constructor({ getTab }) {
    this.getTab = getTab;
    this.refs = new Map();
    this.navigationVersions = new Map();
    this.enabledTabs = new Set();
    this.counter = 0;
  }

  invalidate(tabId) {
    this.navigationVersions.set(tabId, (this.navigationVersions.get(tabId) || 0) + 1);
    for (const [ref, target] of this.refs) if (target.tabId === tabId) this.refs.delete(ref);
  }

  disposeTab(tabId) {
    this.invalidate(tabId);
    this.navigationVersions.delete(tabId);
    this.enabledTabs.delete(tabId);
  }

  tab(tabId) {
    const tab = this.getTab(tabId);
    if (!tab || tab.view.webContents.isDestroyed()) throw new Error(`unknown or closed tab: ${tabId}`);
    return tab;
  }

  async ensureDebugger(tab) {
    const dbg = tab.view.webContents.debugger;
    if (this.enabledTabs.has(tab.id) && dbg.isAttached()) return dbg;
    if (!dbg.isAttached()) {
      try { dbg.attach('1.3'); } catch (error) { throw new Error(`page automation unavailable: ${error.message}`); }
    }
    await Promise.all([
      dbg.sendCommand('DOM.enable'),
      dbg.sendCommand('Accessibility.enable'),
      dbg.sendCommand('Page.enable'),
    ]);
    this.enabledTabs.add(tab.id);
    dbg.once('detach', () => this.enabledTabs.delete(tab.id));
    return dbg;
  }

  async command(tabId, method, params = {}) {
    const tab = this.tab(tabId);
    const dbg = await this.ensureDebugger(tab);
    return dbg.sendCommand(method, params);
  }

  createRef(tabId, node, basics) {
    const ref = `el_${(++this.counter).toString(36)}`;
    this.refs.set(ref, {
      tabId,
      navigationVersion: this.navigationVersions.get(tabId) || 0,
      backendNodeId: node.backendDOMNodeId,
      axNodeId: node.nodeId,
      ...basics,
    });
    return ref;
  }

  resolveRef(tabId, ref) {
    const target = this.refs.get(ref);
    if (!target || target.tabId !== tabId) throw new Error(`unknown element reference: ${ref}; observe the page again`);
    if (target.navigationVersion !== (this.navigationVersions.get(tabId) || 0)) {
      this.refs.delete(ref);
      throw new Error(`stale element reference: ${ref}; the page navigated, observe it again`);
    }
    this.tab(tabId);
    return target;
  }

  async withObject(tabId, backendNodeId, fn, args = []) {
    const { object } = await this.command(tabId, 'DOM.resolveNode', { backendNodeId });
    if (!object?.objectId) throw new Error('element is no longer available; observe the page again');
    try {
      const result = await this.command(tabId, 'Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: fn,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'page action failed');
      return result.result?.value;
    } finally {
      await this.command(tabId, 'Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
    }
  }

  async detailsForTarget(target) {
    const value = await this.withObject(target.tabId, target.backendNodeId, `function () {
      const e = this;
      if (!e || !e.isConnected) return { stale: true };
      const a = {};
      for (const n of ['id','name','type','role','aria-label','title','alt','href','src','download','formaction','placeholder']) {
        const v = e.getAttribute && e.getAttribute(n); if (v) a[n] = v;
      }
      const r = e.getBoundingClientRect ? e.getBoundingClientRect() : null;
      const s = getComputedStyle(e);
      const form = e.form || e.closest?.('form');
      const formValues = form ? [...form.elements].slice(0,50).map((field) => ({
        name: field.name || field.id || field.getAttribute?.('aria-label') || field.type || field.tagName,
        type: field.type || field.tagName?.toLowerCase(),
        value: ('checked' in field && /checkbox|radio/.test(field.type)) ? !!field.checked : ('value' in field ? String(field.value ?? '') : '')
      })) : [];
      return {
        tag: (e.tagName || '').toLowerCase(), attributes: a,
        text: (e.innerText || e.textContent || '').replace(/\\s+/g,' ').trim().slice(0,1000),
        value: ('value' in e ? String(e.value ?? '') : ''), checked: ('checked' in e ? !!e.checked : undefined),
        href: e.href || a.href || '', src: e.currentSrc || e.src || a.src || '',
        type: e.type || a.type || '', formAction: e.formAction || a.formaction || '', download: a.download || '',
        backgroundImage: s.backgroundImage && s.backgroundImage !== 'none' ? s.backgroundImage : '',
        formValues,
        visible: !!(r && r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'),
        rect: r ? { x:r.x, y:r.y, width:r.width, height:r.height } : null
      };
    }`);
    if (!value || value.stale) throw new Error('element is no longer available; observe the page again');
    return { ...target, ...value, name: target.name || value.attributes?.['aria-label'] || value.text };
  }

  async inspect(tabId, ref) {
    return this.detailsForTarget(this.resolveRef(tabId, ref));
  }

  async observe(tabId) {
    const tab = this.tab(tabId);
    const frameTree = await this.command(tabId, 'Page.getFrameTree').catch(() => null);
    const frameIds = [];
    const collectFrames = (item) => { if (!item?.frame?.id) return; frameIds.push(item.frame.id); for (const child of item.childFrames || []) collectFrames(child); };
    collectFrames(frameTree?.frameTree);
    const responses = frameIds.length
      ? await Promise.all(frameIds.map((frameId) => this.command(tabId, 'Accessibility.getFullAXTree', { depth: 12, frameId }).catch(() => ({ nodes: [] }))))
      : [await this.command(tabId, 'Accessibility.getFullAXTree', { depth: 12 })];
    const seen = new Set();
    const nodes = responses.flatMap((response, frameIndex) => (response.nodes || []).map((node) => ({ ...node, _frameIndex: frameIndex })))
      .filter((node) => { const key = `${node._frameIndex}:${node.nodeId}`; if (node.ignored || seen.has(key)) return false; seen.add(key); return true; })
      .slice(0, MAX_AX_NODES);
    const output = [];
    const detailJobs = [];
    let refCount = 0;

    for (const node of nodes) {
      const role = clean(axValue(node.role), 80);
      const name = clean(axValue(node.name), 800);
      const value = clean(axValue(node.value), 1200);
      if (!role || (!name && !value) || role === 'none' || role === 'generic') continue;

      const props = {};
      for (const prop of node.properties || []) {
        const v = axValue(prop.value);
        if (v !== undefined && ['checked','disabled','editable','expanded','focused','required','selected'].includes(prop.name)) props[prop.name] = v;
      }
      const entry = { role, name, value, properties: props };
      if (node.backendDOMNodeId && INTERACTIVE_ROLES.has(role) && refCount < MAX_REFS) {
        entry.ref = this.createRef(tabId, node, { role, name, value });
        refCount++;
        if (DETAIL_ROLES.has(role) && detailJobs.length < 80) {
          detailJobs.push(this.inspect(tabId, entry.ref).then((details) => {
            entry.tag = details.tag; entry.type = details.type; entry.href = details.href;
            entry.src = details.src; entry.value = details.value || entry.value;
            entry.checked = details.checked; entry.visible = details.visible;
          }).catch(() => {}));
        }
      }
      output.push(entry);
    }
    await Promise.all(detailJobs);

    const result = {
      tab: { id: tabId, title: tab.title, url: tab.url, navigationVersion: this.navigationVersions.get(tabId) || 0 },
      elements: output,
      limitations: 'DOM accessibility snapshot only; canvas, remote desktop, closed shadow roots, and pixel-only controls are not represented.',
    };
    return capResult(result);
  }

  async click(tabId, ref) {
    const target = this.resolveRef(tabId, ref);
    const result = await this.withObject(tabId, target.backendNodeId, `function () {
      if (!this.isConnected) return { stale:true };
      this.scrollIntoView({block:'center', inline:'center'}); this.focus({preventScroll:true});
      const r=this.getBoundingClientRect(); const s=getComputedStyle(this);
      if (!(r.width>0&&r.height>0) || s.visibility==='hidden' || s.display==='none') return {visible:false};
      this.click(); return {clicked:true};
    }`);
    if (!result || result.stale) throw new Error('element is stale; observe the page again');
    if (!result.clicked) throw new Error('element has no clickable area');
    return { clicked: ref };
  }

  async type(tabId, ref, text, replace = true) {
    const target = this.resolveRef(tabId, ref);
    return this.withObject(tabId, target.backendNodeId, `function (text, replace) {
      if (!this.isConnected) return {stale:true}; this.focus();
      if (this.isContentEditable) {
        if (replace) this.textContent = text; else this.textContent += text;
      } else if ('value' in this) {
        const proto = this.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        const next = replace ? text : String(this.value || '') + text;
        if (setter) setter.call(this, next); else this.value = next;
      } else { return {error:'target is not editable'}; }
      this.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));
      this.dispatchEvent(new Event('change',{bubbles:true})); return {value:this.value ?? this.textContent};
    }`, [String(text), !!replace]);
  }

  async select(tabId, ref, value) {
    const target = this.resolveRef(tabId, ref);
    return this.withObject(tabId, target.backendNodeId, `function (wanted) {
      if (!(this instanceof HTMLSelectElement)) return {error:'target is not a select'};
      const option=[...this.options].find(o=>o.value===wanted||o.label===wanted||o.text===wanted);
      if (!option) return {error:'option not found'}; this.value=option.value;
      this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true}));
      return {value:this.value,label:option.label||option.text};
    }`, [String(value)]);
  }

  async setChecked(tabId, ref, checked) {
    const target = this.resolveRef(tabId, ref);
    return this.withObject(tabId, target.backendNodeId, `function (wanted) {
      if (!('checked' in this)) return {error:'target is not checkable'};
      if (!!this.checked !== !!wanted) this.click(); return {checked:!!this.checked};
    }`, [!!checked]);
  }

  async pressKey(tabId, ref, key) {
    if (ref) {
      const target = this.resolveRef(tabId, ref);
      await this.withObject(tabId, target.backendNodeId, 'function(){ this.focus(); return true; }');
    }
    const allowed = new Set(['Enter','Tab','Escape','Backspace','Delete','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown','Space']);
    if (!allowed.has(key) && String(key).length !== 1) throw new Error(`unsupported key: ${key}`);
    const normalized = key === 'Space' ? ' ' : key;
    await this.command(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: normalized, text: normalized.length === 1 ? normalized : undefined });
    await this.command(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: normalized });
    return { pressed: key };
  }

  async scroll(tabId, { ref, direction = 'down', amount = 600 }) {
    if (ref) {
      const target = this.resolveRef(tabId, ref);
      await this.withObject(tabId, target.backendNodeId, `function(){this.scrollIntoView({block:'center',inline:'nearest'});return true;}`);
      return { scrolledTo: ref };
    }
    const distance = Math.min(Math.max(Number(amount) || 600, 50), 4000) * (direction === 'up' ? -1 : 1);
    await this.command(tabId, 'Runtime.evaluate', { expression: `window.scrollBy({top:${distance},behavior:'instant'})`, returnByValue: true });
    return { scrolled: distance };
  }

  async setFileInput(tabId, ref, filePath) {
    const target = this.resolveRef(tabId, ref);
    await this.command(tabId, 'DOM.setFileInputFiles', { files: [filePath], backendNodeId: target.backendNodeId });
    return { uploaded: true };
  }

  fingerprint(details) {
    return crypto.createHash('sha256').update(JSON.stringify({
      navigationVersion: details.navigationVersion, backendNodeId: details.backendNodeId,
      tag: details.tag, type: details.type, name: details.name, text: details.text,
      href: details.href, src: details.src, formAction: details.formAction, download: details.download,
      formValues: details.formValues,
    })).digest('hex');
  }
}

module.exports = { PageAutomation, INTERACTIVE_ROLES };
