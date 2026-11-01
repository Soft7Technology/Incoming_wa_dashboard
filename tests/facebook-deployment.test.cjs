const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const express = require('express');

function createApp() {
  const file = path.resolve('library/surefy/src/server.ts');
  const exports = {};
  const dependencies = {
    './middleware/errorHandler': { errorHandler: (err, _req, res, _next) => res.status(500).end() },
    './exceptions/CustomError': { CustomError: Error },
    './routes/health.route': { default: express.Router(), __esModule: true },
    './middleware/upload.middleware': { UPLOADS_DIR: path.resolve('uploads') },
    './utils/asyncRouter': { protectAsyncRoutes: () => {} },
    './middleware/requestCapacity': { requestCapacity: () => (_req, _res, next) => next() },
    'node:fs': { existsSync: () => false },
  };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText, {
    exports, require: id => Object.hasOwn(dependencies, id) ? dependencies[id] : require(id),
    process: { env: { WORKER_MODE: 'true', FACEBOOK_FRONTEND_URL: 'https://app.soft7.in' } },
    __dirname: path.dirname(file), Buffer, URL, console,
  });
  const route = express.Router();
  route.post('/:feature/webhook', (req, res) => res.json({ raw: req.rawBody?.toString('utf8') }));
  return exports.default([{ basePath: '/v1/facebook', route }]);
}

test('Facebook production routes support dashboard credentialed CORS and preserve signed webhook bytes', async t => {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const route of ['/v1/admin/facebook/oauth/start?feature=messaging', '/v1/admin/facebook/pages', '/v1/admin/facebook-leads/setup']) {
    const response = await fetch(base + route, { method: 'OPTIONS', headers: {
      Origin: 'https://app.soft7.in', 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    } });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://app.soft7.in');
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
  }
  const foreign = await fetch(base + '/v1/admin/facebook/pages', { method: 'OPTIONS', headers: {
    Origin: 'https://untrusted.example', 'Access-Control-Request-Method': 'GET',
  } });
  assert.notEqual(foreign.headers.get('access-control-allow-origin'), 'https://untrusted.example');
  assert.notEqual(foreign.headers.get('access-control-allow-origin'), '*');
  for (const feature of ['leads', 'messaging']) {
    const body = '{ "object": "page", "entry": [] }';
    const response = await fetch(`${base}/v1/facebook/${feature}/webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).raw, body);
  }
});
