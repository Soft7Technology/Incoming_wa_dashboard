// Optional UI test in a real Chromium browser. All fixture messages and Meta
// responses are confined to this test process; production has no simulator.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { load, fixture, utils } = require('./facebook-helpers.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('browser logs in, renders incoming text automatically, sends reply and keeps follow-up in same thread', {
  skip: (!process.env.FACEBOOK_TEST_DATABASE_URL || !process.env.FACEBOOK_TEST_CHROME) && 'Set FACEBOOK_TEST_DATABASE_URL and FACEBOOK_TEST_CHROME for browser testing.',
  timeout: 60000,
}, () => fixture(async ({ database, service, meta, connect, inbound, a }) => {
  const controllerModule = load('src/app/http/controllers/facebookMessenger.controller.ts', {
    '../../services/facebookMessenger.service': { __esModule: true, default: service }, '../../utils/facebook': utils,
  });
  const deps = { '../app/http/controllers/facebookMessenger.controller': controllerModule };
  const app = express();
  app.use(express.json({ verify: (req, _res, body) => { req.rawBody = body; } }));
  app.post('/v1/auth/login', (_req, res) => res.json({ success: true, data: { token: 'BROWSER_TEST_JWT', data: { name: 'Test Owner' } } }));
  app.use('/v1/admin/facebook-messenger', (req, res, next) => {
    if (req.headers.authorization !== 'Bearer BROWSER_TEST_JWT') return res.status(401).json({ success: false, message: 'Not logged in' });
    Object.assign(req, a); next();
  }, load('src/routes/facebookMessenger.route.ts', deps).default);
  app.use('/v1/facebook', load('src/routes/facebookPublic.route.ts', deps).default);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const profile = path.resolve('.facebook-test-runtime/chrome-' + crypto.randomUUID()); fs.mkdirSync(profile, { recursive: true });
  const chrome = spawn(process.env.FACEBOOK_TEST_CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let socket, failed = new Error('Chrome failed to start'); chrome.on('error', error => { failed = error; });
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) { if (chrome.exitCode !== null) throw failed; await pause(100); }
    if (!fs.existsSync(portFile)) throw failed;
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const target = (await (await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(5000) })).json()).find(t => t.type === 'page');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Chrome debugging connection timed out')), 5000);
      socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Chrome debugging connection failed')); }, { once: true });
    });
    let requestId = 0; const waiting = new Map(); const errors = [];
    socket.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails); const pending = waiting.get(message.id); if (pending) { waiting.delete(message.id); clearTimeout(pending.timeout); message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result); } });
    const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++requestId; const timeout = setTimeout(() => { waiting.delete(id); reject(new Error('Chrome timed out: ' + method)); }, 5000); waiting.set(id, { resolve, reject, timeout }); socket.send(JSON.stringify({ id, method, params })); });
    const evaluate = async expression => { const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result.value; };
    const waitFor = async expression => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await pause(100); } throw new Error('Browser condition did not become true: ' + expression); };
    await call('Runtime.enable'); await call('Page.enable');
    await connect(); await call('Page.navigate', { url: base + '/v1/facebook/page' });
    await waitFor("Boolean(document.getElementById('login-form')) && typeof api === 'function'");
    await evaluate("document.getElementById('email').value='owner@example.test';document.getElementById('password').value='test-password';document.getElementById('domain').value='localhost';document.getElementById('login-form').requestSubmit()");
    await waitFor("!document.getElementById('workspace').hidden && document.getElementById('pages').innerText.includes('Review Test Page')");
    assert.equal(await evaluate("document.getElementById('connect').disabled"), false);
    assert.equal(await evaluate("document.getElementById('pages').innerText.includes('TEST_PAGE_TOKEN')"), false);
    await evaluate("document.getElementById('inbox-tab').click()");
    const post = async data => { const body = JSON.stringify(data); const response = await fetch(base + '/v1/facebook/webhook', { method: 'POST', signal: AbortSignal.timeout(5000), headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + crypto.createHmac('sha256', process.env.FACEBOOK_APP_SECRET).update(body).digest('hex') }, body }); assert.equal(response.status, 200); };
    await post(inbound());
    await waitFor("Boolean(document.querySelector('.conversation'))");
    await evaluate("document.querySelector('.conversation').click()");
    await waitFor("document.getElementById('messages').innerText.includes('Hello, I need help with my order.')");
    await evaluate("document.getElementById('reply').value='Hello! Please share your order number so we can help.';document.getElementById('reply-form').requestSubmit()");
    await waitFor("document.getElementById('messages').innerText.includes('Hello! Please share your order number so we can help.') && document.getElementById('messages').innerText.includes('sent')");
    assert.equal(meta.calls.filter(c => c.path.endsWith('/messages')).length, 1);
    await post(inbound('follow-up', 'My order number is 1234.'));
    await waitFor("document.getElementById('messages').innerText.includes('My order number is 1234.')");
    assert.equal((await database('facebook_conversations')).length, 1);
    await post(inbound('follow-up', 'My order number is 1234.'));
    await pause(2200); assert.equal(await evaluate("document.querySelectorAll('.message.inbound').length"), 2);
    assert.equal(errors.length, 0, JSON.stringify(errors));
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
    const screenshot = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.resolve('.facebook-test-runtime/browser-inbox.png'), Buffer.from(screenshot.data, 'base64'));
    await evaluate("document.getElementById('logout').click()");
    assert.equal(await evaluate("document.getElementById('workspace').hidden && !document.getElementById('login-panel').hidden"), true);
  } finally {
    if (socket) socket.close(); chrome.kill(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}));
