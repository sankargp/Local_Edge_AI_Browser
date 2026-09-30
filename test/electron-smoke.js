'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { PageAutomation } = require('../src/page-automation');

function fixture(childPort) { return `<!doctype html><title>Agent fixture</title>
<main><h1>Automation fixture</h1><label>Name <input id="name" value="old"></label>
<label>Priority <select id="priority"><option>Low</option><option>High</option></select></label>
<label><input id="ready" type="checkbox"> Ready</label>
<button id="plain" onclick="document.body.dataset.clicked='yes'">Expand details</button>
<button id="submit" type="submit">Submit request</button>
<img alt="Fixture image" src="https://example.test/image.png">
<div id="shadow"></div><iframe src="http://127.0.0.1:${childPort}/frame"></iframe>
<script>const root=shadow.attachShadow({mode:'open'});const button=document.createElement('button');button.textContent='Shadow action';button.onclick=()=>shadow.dataset.clicked='yes';root.append(button)</script></main>`; }

function listen(server) { return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))); }

app.whenReady().then(async () => {
  const childServer = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<button onclick="document.body.dataset.clicked=\'yes\'">Cross frame action</button>'); });
  const childPort = await listen(childServer);
  const parentServer = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(fixture(childPort)); });
  const parentPort = await listen(parentServer);
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  const tab = { id: 'fixture', title: 'Agent fixture', url: 'about:blank', view: { webContents: window.webContents } };
  const automation = new PageAutomation({ getTab: (id) => id === tab.id ? tab : null });
  try {
    await window.loadURL(`http://127.0.0.1:${parentPort}/`);
    tab.url = window.webContents.getURL();
    const snapshot = await automation.observe(tab.id);
    assert.equal(snapshot.tab.title, 'Agent fixture');
    const textbox = snapshot.elements.find((item) => item.role === 'textbox');
    const select = snapshot.elements.find((item) => item.role === 'combobox');
    const check = snapshot.elements.find((item) => item.role === 'checkbox');
    const plain = snapshot.elements.find((item) => item.name === 'Expand details');
    const image = snapshot.elements.find((item) => item.role === 'image');
    const shadow = snapshot.elements.find((item) => item.name === 'Shadow action');
    const crossFrame = snapshot.elements.find((item) => item.name === 'Cross frame action');
    assert.ok(textbox?.ref && select?.ref && check?.ref && plain?.ref && image?.ref);
    assert.ok(shadow?.ref, 'open shadow DOM control should be observed');
    assert.ok(crossFrame?.ref, 'cross-origin iframe control should be observed');
    await automation.type(tab.id, textbox.ref, 'updated', true);
    await automation.select(tab.id, select.ref, 'High');
    await automation.setChecked(tab.id, check.ref, true);
    await automation.click(tab.id, plain.ref);
    await automation.click(tab.id, shadow.ref);
    await automation.click(tab.id, crossFrame.ref);
    const state = await window.webContents.executeJavaScript(`({name:document.getElementById('name').value,priority:document.getElementById('priority').value,ready:document.getElementById('ready').checked,clicked:document.body.dataset.clicked})`);
    assert.deepEqual(state, { name: 'updated', priority: 'High', ready: true, clicked: 'yes' });
    assert.equal(await window.webContents.executeJavaScript(`document.getElementById('shadow').dataset.clicked`), 'yes');
    assert.equal(await window.webContents.mainFrame.frames[0].executeJavaScript('document.body.dataset.clicked'), 'yes');
    const imageDetails = await automation.inspect(tab.id, image.ref);
    assert.equal(imageDetails.src, 'https://example.test/image.png');

    automation.invalidate(tab.id);
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'customer-intake-demo.html'));
    tab.url = window.webContents.getURL(); tab.title = window.webContents.getTitle();
    const intake = await automation.observe(tab.id);
    for (const label of ['Full name', 'Email address', 'Phone number', 'Website', 'Company', 'Street address', 'City', 'ZIP code', 'Create customer']) {
      assert.ok(intake.elements.some((item) => item.name === label), `customer intake should expose ${label}`);
    }
    console.log('Electron page-automation smoke test passed.');
  } catch (error) {
    console.error(error); process.exitCode = 1;
  } finally {
    window.destroy(); childServer.close(); parentServer.close(); app.exit(process.exitCode || 0);
  }
});
