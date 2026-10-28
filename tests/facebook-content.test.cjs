const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { load, fixture, utils, contentModule, contentMigration } = require('./facebook-helpers.cjs');
const local = !process.env.FACEBOOK_TEST_DATABASE_URL && 'Set FACEBOOK_TEST_DATABASE_URL to isolated local PostgreSQL.';
const dbTest = (name, run) => test(name, { skip: local }, () => contentFixture(run));

async function contentFixture(run) {
  const oldConfig = process.env.FACEBOOK_PAGES_LOGIN_CONFIG_ID, oldMode = process.env.FACEBOOK_PAGES_LOGIN_MODE;
  process.env.FACEBOOK_PAGES_LOGIN_CONFIG_ID = '10006'; process.env.FACEBOOK_PAGES_LOGIN_MODE = 'business';
  try { await fixture(async context => {
    const { meta, contentService: content, a } = context;
    const grants = Array.from(contentModule.contentPermissions);
    meta.grants = grants;
    meta.inspectPage = async () => ({ expires: null, granted: meta.pageGrants || grants });
    const rows = [
      { id: '20001_30001', message: 'Our Page update', from: { id: '20001', name: 'Review Test Page' }, permalink_url: 'https://www.facebook.com/20001/posts/30001', created_time: new Date().toISOString() },
      { id: '20001_30002', message: '<img src=x onerror=alert(1)> Visitor question', from: { id: '40001', name: 'Customer' }, permalink_url: 'https://www.facebook.com/20001/posts/30002', created_time: new Date().toISOString() },
    ];
    meta.call = async (path, token, method = 'GET', params = {}, body) => {
      meta.calls.push({ path, token, method, params, body });
      if (meta.failure) throw meta.failure;
      if (path === '20001') return { id: '20001', name: 'Review Test Page' };
      if (path === '20001/feed' && method === 'GET') return { data: rows, ...(meta.paging ? { paging: meta.paging } : {}) };
      if (path.endsWith('/comments')) return { data: [{ id: '50001', message: 'Is delivery available? <img src=x>', from: { id: '40002', name: 'Commenter' }, created_time: new Date().toISOString() }] };
      if (path === '20001/feed' && method === 'POST') { const id = '20001_' + (40000 + rows.length); rows.unshift({ id, message: body.message, from: { id: '20001', name: 'Review Test Page' }, permalink_url: 'https://www.facebook.com/' + id, created_time: new Date().toISOString() }); return { id }; }
      const row = rows.find(row => row.id === path);
      if (row && method === 'POST') { row.message = body.message; return { success: true }; }
      if (row && method === 'DELETE') { rows.splice(rows.indexOf(row), 1); return { success: true }; }
      throw new Error('Unexpected Meta fixture path ' + path);
    };
    async function login(scope = a) { const result = await content.start(scope); return { ...result, state: new URL(result.url).searchParams.get('state') }; }
    async function connect(scope = a) { const session = await login(scope); assert.equal(await content.callback(session.state, session.browser, 'FIXTURE_CODE', false), 'ready'); return content.connect(scope, session.browser, '20001'); }
    await run({ ...context, content, grants, rows, loginContent: login, connectContent: connect });
  }); } finally { if (oldConfig === undefined) delete process.env.FACEBOOK_PAGES_LOGIN_CONFIG_ID; else process.env.FACEBOOK_PAGES_LOGIN_CONFIG_ID = oldConfig; if (oldMode === undefined) delete process.env.FACEBOOK_PAGES_LOGIN_MODE; else process.env.FACEBOOK_PAGES_LOGIN_MODE = oldMode; }
}

dbTest('Page content OAuth binds the browser, app and redirect, checks grants and consumes selection once', async ({ content, loginContent, a, b, meta, database }) => {
  const session = await loginContent(), url = new URL(session.url);
  assert.equal(url.searchParams.get('config_id'), '10006'); assert.ok(url.searchParams.get('redirect_uri').endsWith('/posts/oauth/callback'));
  await assert.rejects(content.callback(session.state, utils.random(), 'CODE', false), e => e.status === 403);
  assert.equal(await content.callback(session.state, session.browser, 'CODE', false), 'ready');
  assert.equal((await content.candidates(b, session.browser)).pages.length, 0);
  assert.ok(!JSON.stringify(await content.candidates(a, session.browser)).includes('TEST_PAGE_TOKEN'));
  const connected = await content.connect(a, session.browser, '20001');
  const stored = await database('facebook_content_pages').where({ id: connected.id }).first();
  assert.equal(utils.decrypt(stored.token_ciphertext), 'TEST_PAGE_TOKEN'); assert.equal(connected.token_ciphertext, undefined);
  await assert.rejects(content.callback(session.state, session.browser, 'CODE', false), e => e.status === 403);
  await assert.rejects(content.connect(a, session.browser, '20001'), e => e.status === 409);
  const missing = await loginContent(); meta.grants = ['pages_show_list'];
  assert.equal(await content.callback(missing.state, missing.browser, 'CODE', false), 'failed');
  assert.match((await content.candidates(a, missing.browser)).error, /pages_read_user_content/);
});

dbTest('Page content token import works without a Login configuration and preserves workspace ownership', async ({ content, a, b, other, member, database, meta, grants, connectContent, loginContent }) => {
  await connectContent();
  await assert.rejects(connectContent(b), /another workspace/);
  await assert.rejects(connectContent(other), /another workspace/);
  await assert.rejects(content.start(member), /account owner/);
  await assert.rejects(content.start({ ...a, reviewPageId: '20001' }), e => e.status === 403);
  delete process.env.FACEBOOK_PAGES_LOGIN_CONFIG_ID;
  await assert.rejects(content.start(a), /FACEBOOK_PAGES_LOGIN_CONFIG_ID/);
  const imported = await content.importToken(a, 'VALID_PRIVATE_USER_TOKEN_123');
  assert.equal((await content.candidates(a, imported.browser)).status, 'ready');
  assert.equal((await content.connect(a, imported.browser, '20001')).status, 'connected');
  meta.pageGrants = grants.filter(p => p !== 'pages_manage_posts');
  const another = await content.importToken(a, 'VALID_PRIVATE_USER_TOKEN_456');
  await assert.rejects(content.connect(a, another.browser, '20001'), /pages_manage_posts/);
  assert.ok(!(await database('facebook_content_oauth')).some(row => row.candidates_ciphertext?.includes('VALID_PRIVATE_USER_TOKEN')));
});

dbTest('Page feed and comments read user content, deduplicate and enforce Page ownership and safe cursors', async ({ content, a, b, other, connectContent, meta, rows, database }) => {
  const page = await connectContent();
  rows.push({ id: '99999_30003', message: 'Foreign post' });
  meta.paging = { next: 'https://evil.example/leak', cursors: { after: 'next-cursor' } };
  const sync = await content.sync(a, page.id); assert.equal(sync.next_cursor, 'next-cursor');
  await content.sync(a, page.id, undefined, 'safe-cursor');
  const posts = await content.posts(a, page.id); assert.equal(posts.length, 2); assert.equal(posts.filter(p => p.from_page === false).length, 1);
  const post = posts.find(p => p.from_page === true); await content.sync(a, page.id, post.id); await content.sync(a, page.id, post.id);
  assert.equal((await content.comments(a, page.id, post.id)).length, 1);
  for (const scope of [b, other]) await assert.rejects(content.posts(scope, page.id), e => e.status === 404);
  await assert.rejects(content.comments(a, page.id, crypto.randomUUID()), e => e.status === 404);
  await assert.rejects(content.sync(a, page.id, undefined, '\nBAD_CURSOR'), e => e.status === 400);
  assert.ok(meta.calls.every(c => !c.path.startsWith('http')));
  assert.ok(meta.calls.filter(c => c.path.endsWith('/feed') || c.path.endsWith('/comments')).every(c => c.token === 'TEST_PAGE_TOKEN'));
});

dbTest('Page post create, edit and delete use Page credentials and suppress duplicate mutation requests', async ({ content, a, b, connectContent, meta }) => {
  const page = await connectContent();
  const input = { client_request_id: crypto.randomUUID(), message: 'A new Page update', link: 'https://example.test/news' };
  const results = await Promise.all([content.action(a, page.id, 'create', input), content.action(a, page.id, 'create', input)]);
  assert.ok(results.every(r => ['confirmed', 'pending'].includes(r.status)));
  const action = await content.action(a, page.id, 'create', input); assert.equal(action.status, 'confirmed');
  assert.equal(meta.calls.filter(c => c.path === '20001/feed' && c.method === 'POST').length, 1);
  await assert.rejects(content.action(a, page.id, 'create', { ...input, message: 'different' }), e => e.status === 409);
  const postId = action.result.post_id;
  const edit = { client_request_id: crypto.randomUUID(), message: 'Updated Page text' };
  assert.equal((await content.action(a, page.id, 'edit', edit, postId)).status, 'confirmed');
  assert.equal((await content.action(a, page.id, 'edit', edit, postId)).status, 'confirmed');
  await assert.rejects(content.action(b, page.id, 'delete', { client_request_id: crypto.randomUUID() }, postId), e => e.status === 404);
  const deletion = { client_request_id: crypto.randomUUID() };
  assert.equal((await content.action(a, page.id, 'delete', deletion, postId)).status, 'confirmed');
  assert.equal((await content.action(a, page.id, 'delete', deletion, postId)).status, 'confirmed');
  assert.equal(meta.calls.filter(c => c.path === action.result.remote_id && c.method === 'DELETE').length, 1);
  assert.equal((await content.posts(a, page.id)).find(p => p.id === postId).deleted, true);
  await content.sync(a, page.id); const native = (await content.posts(a, page.id)).find(p => !p.managed);
  await assert.rejects(content.action(a, page.id, 'edit', edit, native.id), e => e.status === 409 || e.status === 403);
  await assert.rejects(content.action(a, page.id, 'create', { message: 'test', link: 'http://bad.example', client_request_id: crypto.randomUUID() }), e => e.status === 400);
});

dbTest('Unconfirmed Page actions never retry automatically and Meta lifecycle callbacks erase local content', async ({ content, service, a, connectContent, meta, database }) => {
  const page = await connectContent(); await content.sync(a, page.id);
  const posts = await content.posts(a, page.id); await content.sync(a, page.id, posts[0].id);
  const input = { client_request_id: crypto.randomUUID(), message: 'Uncertain post' };
  meta.failure = new Error('PRIVATE_HTTP_DETAILS');
  const result = await content.action(a, page.id, 'create', input); assert.equal(result.status, 'unconfirmed'); assert.ok(!result.error.includes('PRIVATE'));
  meta.failure = null;
  assert.equal((await content.action(a, page.id, 'create', input)).status, 'unconfirmed');
  assert.equal(meta.calls.filter(c => c.path === '20001/feed' && c.method === 'POST').length, 1);
  await database('users').where({ id: a.ownerId }).update({ status: 'suspended' });
  await service.revoke('30001', false); assert.equal((await database('facebook_content_pages').first()).token_ciphertext, null);
  await service.revoke('30001', true);
  for (const table of ['facebook_content_pages','facebook_content_posts','facebook_content_comments','facebook_content_actions','facebook_content_oauth']) assert.equal((await database(table)).length, 0);
});

async function httpFixture(context, run) {
  const { content, a } = context;
  const messenger = load('src/app/http/controllers/facebookMessenger.controller.ts', {
    '../../services/facebookMessenger.service': { __esModule: true, default: context.service },
    '../../services/facebookLeads.service': { __esModule: true, default: context.leadService },
    '../../services/instagram.service': { __esModule: true, default: context.instagramService }, '../../utils/facebook': utils,
  });
  const controller = load('src/app/http/controllers/facebookContent.controller.ts', {
    '../../services/facebookContent.service': { ...contentModule, __esModule: true, default: content },
    '../../utils/facebook': utils, './facebookMessenger.controller': messenger,
  });
  const deps = { '../app/http/controllers/facebookMessenger.controller': messenger, '../app/http/controllers/facebookContent.controller': controller,
    '../app/http/controllers/facebookAds.controller': { __esModule: true, default: { callback: (_req, res) => res.sendStatus(400) } },
    '../app/http/controllers/facebookLeads.controller': { __esModule: true, default: { callback: (_req, res) => res.sendStatus(400) } },
    '../app/http/controllers/instagram.controller': { __esModule: true, default: Object.fromEntries(['callback','verify','receive','deauthorize','deletion','publishingMedia'].map(key => [key, (_req,res) => res.sendStatus(400)])) },
    './facebookLoginTest.route': express.Router(), './facebookReviewLogin.route': express.Router() };
  class Unauthorized extends Error { constructor(data) { super(data.message); this.status = 401; } }
  const auth = load('library/surefy/src/middleware/jwtAuth.middleware.ts', { '../database': context.database, '../exceptions/HTTP401Error': Unauthorized, '../utils/facebookReviewSession': load('library/surefy/src/utils/facebookReviewSession.ts') }).jwtAuthMiddleware;
  const bearer = scope => jwt.sign({ userId: scope.userId, ownerId: scope.ownerId, companyId: scope.companyId, role: 'company' }, process.env.JWT_SECRET);
  const app = express(); app.use(express.json());
  app.post('/v1/auth/login', (_req,res) => res.json({ success: true, data: { token: bearer(a) } }));
  app.use('/v1/admin/facebook-content', auth, load('src/routes/facebookContent.route.ts', deps).default);
  // Public browser fixture uses the selected test owner; tenant/cookie checks have their own tests.
  deps['./publicMetaWorkspace.route'] = express.Router();
  app.post('/v1/facebook/session', (_req, res) => res.json({ success: true, data: { ready: true } }));
  app.use('/v1/facebook/api/posts', (req, _res, next) => { Object.assign(req, a); next(); },
    load('src/routes/facebookContent.route.ts', deps).default);
  app.use('/v1/facebook', load('src/routes/facebookPublic.route.ts', deps).default);
  const server = app.listen(0,'127.0.0.1'); await new Promise(resolve => server.once('listening',resolve));
  try { await run('http://127.0.0.1:' + server.address().port, bearer); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

dbTest('Page content HTTP routes bind cookies and OAuth callback and reject unauthorized or foreign owners', async context => {
  await httpFixture(context, async (base, bearer) => {
    const endpoint = base + '/v1/admin/facebook-content', headers = { Authorization: 'Bearer ' + bearer(context.a), 'Content-Type': 'application/json' };
    assert.equal((await fetch(endpoint + '/pages')).status,401);
    let response = await fetch(endpoint + '/oauth/start', { method: 'POST', headers, body: '{}' });
    const cookie = response.headers.get('set-cookie').split(';')[0]; assert.match(response.headers.get('set-cookie'), /HttpOnly.*Secure.*SameSite=Lax/);
    const started = (await response.json()).data, state = new URL(started.authorization_url).searchParams.get('state');
    response = await fetch(base + '/v1/facebook/posts/oauth/callback?state=' + state + '&code=CODE', { headers: { Cookie: cookie }, redirect: 'manual' }); assert.equal(response.status,303);
    response = await fetch(endpoint + '/pages', { method: 'POST', headers: { ...headers, Cookie: cookie }, body: '{"page_id":"20001"}' }); assert.equal(response.status,200);
    const page = (await response.json()).data;
    response = await fetch(endpoint + '/pages/' + page.id + '/posts', { headers: { Authorization: 'Bearer ' + bearer(context.b) } }); assert.equal(response.status,404);
    response = await fetch(endpoint + '/pages/' + page.id + '/posts', { method: 'POST', headers, body: JSON.stringify({ message: 'HTTP published update', client_request_id: crypto.randomUUID() }) }); assert.equal(response.status,200); assert.equal((await response.json()).data.status,'confirmed');
    response = await fetch(base + '/v1/facebook/posts'); assert.equal(response.status,200); assert.match(await response.text(), /pages_read_user_content/);
  });
});

test('Page posts browser reads visitor content and comments and creates, edits and deletes an app post', { skip: local || !process.env.FACEBOOK_TEST_CHROME && 'Set FACEBOOK_TEST_CHROME.', timeout: 60000 }, () => contentFixture(async context => {
  const fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process');
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms)); await context.connectContent();
  await httpFixture(context, async base => {
    const profile = path.resolve('.facebook-test-runtime/content-chrome-' + crypto.randomUUID()); fs.mkdirSync(profile,{recursive:true});
    const chrome = spawn(process.env.FACEBOOK_TEST_CHROME,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
    let socket;
    try {
      const portFile = path.join(profile,'DevToolsActivePort'); for (let i=0;i<100&&!fs.existsSync(portFile);i++) await pause(100);
      const port = fs.readFileSync(portFile,'utf8').split('\n')[0]; const target = (await (await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(t=>t.type==='page');
      socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
      let seq=0; const waiting=new Map(), errors=[];
      socket.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params);if(m.method==='Page.javascriptDialogOpening')call('Page.handleJavaScriptDialog',{accept:true}).catch(()=>{});const pending=waiting.get(m.id);if(pending){waiting.delete(m.id);clearTimeout(pending.timer);m.error?pending.reject(new Error(m.error.message)):pending.resolve(m.result);}});
      const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>reject(new Error('Chrome timeout: '+method)),5000);waiting.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
      const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result.value;};
      const waitFor=async expression=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await pause(100);}throw new Error('Browser condition failed: '+expression+' Notice: '+await evaluate("document.getElementById('notice').textContent"));};
      await call('Runtime.enable');await call('Page.enable');await call('Page.navigate',{url:base+'/v1/facebook/posts'});
      await waitFor("!document.getElementById('workspace').hidden && typeof api==='function'");
      await waitFor("Boolean(document.querySelector('#pages button'))");await evaluate("document.querySelector('#pages button').click()");
      await waitFor("!document.getElementById('page-workspace').hidden");await evaluate("document.getElementById('refresh-feed').click()");
      await waitFor("document.getElementById('posts').innerText.includes('Visitor question')");assert.equal(await evaluate("document.querySelector('#posts img')===null"),true);
      await evaluate("document.querySelector('#posts button').click()");await waitFor("document.getElementById('comments').innerText.includes('Is delivery available?')");assert.equal(await evaluate("document.querySelector('#comments img')===null"),true);
      await evaluate("document.getElementById('post-text').value='Browser Page update';document.getElementById('post-form').requestSubmit()");
      await waitFor("document.getElementById('posts').innerText.includes('Browser Page update') && document.getElementById('notice').textContent==='Post published on Facebook.'");
      await evaluate("Array.from(document.querySelectorAll('#posts article')).find(c=>c.textContent.includes('Browser Page update')).querySelectorAll('button')[1].click()");
      await evaluate("const c=Array.from(document.querySelectorAll('#posts article')).find(c=>c.textContent.includes('Browser Page update'));c.querySelector('textarea').value='Edited browser update';c.querySelector('form').requestSubmit()");
      await waitFor("document.getElementById('posts').innerText.includes('Edited browser update') && document.getElementById('notice').textContent==='Post updated on Facebook.'");
      await evaluate("Array.from(document.querySelectorAll('#posts article')).find(c=>c.textContent.includes('Edited browser update')).querySelectorAll('button')[2].click()");
      await waitFor("document.getElementById('posts').innerText.includes('Deleted post')");assert.equal(errors.length,0,JSON.stringify(errors));
      const screenshot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});fs.writeFileSync(path.resolve('.facebook-test-runtime/facebook-content-browser.png'),Buffer.from(screenshot.data,'base64'));
      assert.equal(context.meta.calls.filter(c=>c.method==='POST'&&c.path==='20001/feed').length,1);
    } finally {if(socket)socket.close();chrome.kill();}
  });
}));
