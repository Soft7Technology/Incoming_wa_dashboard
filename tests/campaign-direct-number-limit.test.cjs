require('ts-node/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const express = require('express');
const HttpError = require('../library/surefy/src/exceptions/HTTP400Error').default;
const { CustomError } = require('../library/surefy/src/exceptions/CustomError');
function load(file, deps) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText, { exports, console, process: { env: {} }, require: name => {
    assert.ok(name in deps, `Missing dependency: ${name}`); return deps[name];
  } });
  return exports;
}

test('actual campaign routes return HTTP 400 with actionable error metadata before any plan or controller work', async () => {
  const middleware = load('src/app/http/middleware/campaignPhoneValidation.ts', {
    '@surefy/exceptions/HTTP400Error': HttpError,
    '../../utils/campaignPhone': require('../src/app/utils/campaignPhone'),
  }).validateCampaignPhones;
  let planChecks = 0, handlerCalls = 0;
  const handler = (_req, res) => { handlerCalls++; res.status(201).json({ success: true }); };
  const controller = Object.fromEntries(['previewRecipients', 'createCampaign', 'getCampaigns', 'getUsersCampaigns',
    'uploadMedia', 'getCampaignById', 'deleteCampaign', 'startCampaign', 'reBroadcastCampaign', 'pauseCampaign',
    'resumeCampaign', 'testCampaign', 'assignedCampaignToUser', 'getCampaignStats', 'getCampaignMessagesInfo',
    'getCampaignButtonClicks', 'getCampaignProgress'].map(key => [key, handler]));
  const routes = load('src/routes/campaign.route.ts', {
    express,
    '../app/http/middleware/campaignPhoneValidation': { validateCampaignPhones: middleware },
    '@surefy/middleware/upload.middleware': { uploadMediaMiddleware: (_req, _res, next) => next() },
    '@surefy/console/http/controllers/campaign.controller': controller,
    '@surefy/console/app/middleware/plan.middleware': { checkPlanLimit: () => (_req, _res, next) => { planChecks++; next(); } },
  }).default;
  const { errorHandler } = load('library/surefy/src/middleware/errorHandler.ts', {
    '../exceptions/CustomError': { CustomError },
    '../utils/HttpStatusCode': require('../library/surefy/src/utils/HttpStatusCode'),
    '../utils/Response': require('../library/surefy/src/utils/Response'),
    '../utils/databaseErrors': { getDatabaseFailure: () => undefined, reportBackgroundError() {} },
  });
  const app = express();
  app.use(express.json());
  app.use('/v1/admin/campaigns', routes);
  app.use('/v1/api/campaigns', routes);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (endpoint, body) => fetch(base + endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    for (const prefix of ['/v1/admin/campaigns', '/v1/api/campaigns']) {
      for (const suffix of ['', '/preview-recipients']) {
        const response = await post(prefix + suffix, { save_contacts: false, send_immediately: true,
          contact_filters: { contactNumber: Array(151).fill('+919372597458') } });
        assert.equal(response.status, 400);
        const body = await response.json();
        assert.equal(body.success, false); assert.match(body.message, /150.*151.*select a contact list/);
        assert.deepEqual(body.error, { code: 'CAMPAIGN_CONTACT_NUMBER_LIMIT_EXCEEDED',
          field: 'contact_filters.contactNumber', limit: 150, received: 151, required_action: 'SELECT_CONTACT_LIST' });
      }
    }
    assert.equal(planChecks, 0); assert.equal(handlerCalls, 0);
    const allowed = await post('/v1/admin/campaigns', { contact_filters: { contactNumber: Array(150).fill('+919372597458') } });
    assert.equal(allowed.status, 201); assert.equal(planChecks, 1); assert.equal(handlerCalls, 1);
    const imported = await post('/v1/admin/campaigns', { contact_filters: { list_ids: ['23860277-69cd-44c2-b557-08f00ecaf2cf'] } });
    assert.equal(imported.status, 201);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
