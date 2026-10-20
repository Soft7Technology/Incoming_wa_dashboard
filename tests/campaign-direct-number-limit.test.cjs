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

test('campaign routes accept larger direct arrays and reject malformed recipients before plan or controller work', async () => {
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
        for(const count of [151,3000]) {
          const response=await post(prefix+suffix,{send_immediately:false,
            contact_filters:{contactNumber:Array(count).fill('+919372597458')}});
          assert.equal(response.status,201);
        }
      }
    }
    assert.equal(planChecks,4);assert.equal(handlerCalls,8);
    const invalid=Array(3000).fill('+919372597458');invalid[2999]='invalid';
    for(const suffix of ['', '/preview-recipients']) {
      const response=await post('/v1/admin/campaigns'+suffix,{contact_filters:{contactNumber:invalid}});
      assert.equal(response.status,400);
      const body=await response.json();
      assert.equal(body.success,false);assert.match(body.message,/contactNumber\[2999\]/);
    }
    assert.equal(planChecks,4);assert.equal(handlerCalls,8);
    const imported = await post('/v1/admin/campaigns', { contact_filters: { list_ids: ['23860277-69cd-44c2-b557-08f00ecaf2cf'] } });
    assert.equal(imported.status, 201);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
