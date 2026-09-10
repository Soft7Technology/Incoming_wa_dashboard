const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function load(file, dependencies) {
  const exports = {};
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  vm.runInNewContext(js, { exports, require: id => dependencies[id] || {}, console: { info(){}, log(){}, error(){}, warn(){} }, process, Date, setInterval: () => ({ unref(){} }), clearInterval(){} });
  return exports;
}
function service(status, state) {
  const writes = [];
  const queue = { getJob: async () => state ? { getState: async () => state, remove: async () => writes.push('remove') } : null, add: async () => writes.push('add') };
  const model = { findById: async () => ({ id:'c', status, user_id:'u', company_id:'co' }), updateStatus: async (_, status, data) => writes.push({ status, data }) };
  const api = load('src/app/services/campaign.service.ts', { '../models/campaign.model': model, '../../queues/campaignExecution.queue': { campaignExecutionQueue: queue }, '@surefy/exceptions/HTTP400Error': Error }).default;
  return { api, writes };
}
test('start recovers a running campaign whose job failed', async () => {
  const {api,writes} = service('running','failed');
  await api.startCampaign('c');
  assert.equal(writes[0], 'remove');
  assert.equal(writes[1].status, 'scheduled');
  assert.ok(writes[1].data.scheduled_at instanceof Date);
  assert.equal(writes[2], 'add');
});
test('start replaces a paused delayed job instead of silently doing nothing', async () => {
  const {api,writes} = service('paused','delayed');
  await api.startCampaign('c');
  assert.equal(writes[0], 'remove');
  assert.equal(writes.at(-1), 'add');
});
test('start does not duplicate an active campaign', async () => {
  const {api,writes} = service('running','active');
  const result = await api.startCampaign('c');
  assert.equal(result.status, 'active');
  assert.equal(writes.length, 0);
});
test('high load reduces batch and low load respects maximum', () => {
  const {nextBatchSize} = load('src/queues/campaignCapacity.ts', {});
  assert.equal(nextBatchSize(10,.9,.3,10,10),5);
  assert.equal(nextBatchSize(1,.9,.9,200,10),1);
  assert.equal(nextBatchSize(10,.2,.3,10,10),10);
  assert.equal(nextBatchSize(2,.2,.3,10,10),3);
});
test('pacing leaves a recipient pending when wait would occupy a worker too long', async () => {
  let calls = 0;
  const {waitForCampaignPermit} = load('src/queues/campaignPacing.ts', {
    './campaignExecution.queue': { campaignExecutionQueue: { client: Promise.resolve({ eval: async () => { calls++; return 6000; } }) } },
    './campaignCapacity': { campaignCapacity: { messagesPerSecond:10, pairIntervalMs:6000 } }
  });
  assert.equal(await waitForCampaignPermit('sender','+919999999999'), false);
  assert.equal(calls, 1);
});
