const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const express = require('express');

function load(file, dependencies = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText, { exports, Buffer, console, require: id => dependencies[id] || {} }, { filename: file });
  return exports;
}
class BadRequest extends Error { constructor({ message }) { super(message); this.statusCode = 400; } }
class Forbidden extends Error { constructor({ message }) { super(message); this.statusCode = 403; } }
const http = load('library/surefy/src/utils/Controller.ts', {
  './Response': { sendResponse: (res, status, success, message, data) => res.status(status).json({ success, message, data }) },
  './HttpStatusCode': { HttpStatusCode: { OK: 200 } },
});
const policy = load('src/app/utils/passwordPolicy.ts', { '@surefy/exceptions/HTTP400Error': BadRequest });

test('password reset returns validation and asynchronous failures through Express without crashing', async () => {
  const resets = [], audits = [];
  const controller = load('src/app/http/controllers/company.controller.ts', {
    '@surefy/utils/Controller': http,
    '@surefy/exceptions/HTTP400Error': BadRequest,
    '@surefy/exceptions/HTTP403Error': Forbidden,
    '../../utils/passwordPolicy': policy,
    '@surefy/console/services/company.service': { resetUserPassword: async (id, password) => {
      resets.push({ id, password });
      if (password === 'rejected-password') throw new BadRequest({ message: 'Hashing rejected password' });
      return { id };
    } },
    '../../models/activityLogs.model': { create: async row => audits.push(row) },
  }).default;
  const app = express();
  app.use(express.json());
  app.put('/:id/reset-password', (req, _res, next) => {
    req.userRole = req.headers['x-test-role'] || 'admin'; next();
  }, controller.resetUserPassword);
  app.get('/health', (_req, res) => res.json({ success: true }));
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const reset = (password, role = 'admin') => fetch(`${base}/test-user/reset-password`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-test-role': role }, body: JSON.stringify({ password }),
  });
  try {
    for (const password of ['', 'short123', 'a'.repeat(73), '😀'.repeat(19), { length: 20 }]) {
      assert.equal((await reset(password)).status, 400);
    }
    assert.equal(resets.length, 0, 'invalid passwords must not reach database or hashing');
    assert.equal((await reset('valid-password', 'user')).status, 403);
    assert.equal((await reset('rejected-password')).status, 400);
    assert.equal(audits.length, 0);
    assert.equal((await fetch(`${base}/health`)).status, 200, 'API remains available after errors');
    assert.equal((await reset('valid-password')).status, 200);
    assert.equal(audits.length, 1);
    assert.equal(JSON.stringify(audits[0].new_data), JSON.stringify({ password_reset: true }));
    assert.equal(JSON.stringify(audits[0]).includes('valid-password'), false);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
