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
  assert.equal(nextBatchSize(4,.9,.3,10,10),2);
  assert.equal(nextBatchSize(2,.9,.3,10,10),2);
  assert.equal(nextBatchSize(1,.9,.9,200,10),1);
  assert.equal(nextBatchSize(10,.2,.3,10,10),10);
  assert.equal(nextBatchSize(2,.2,.3,10,10),3);
});
test('pacing leaves a recipient pending when wait would occupy a worker too long', async () => {
  let calls = 0;
  let keyCount;
  const {waitForCampaignPermit} = load('src/queues/campaignPacing.ts', {
    './campaignExecution.queue': { campaignExecutionQueue: { client: Promise.resolve({ eval: async (_, count) => { calls++; keyCount=count; return 6000; } }) } },
    './campaignCapacity': { campaignCapacity: { messagesPerSecond:10, pairIntervalMs:6000 } }
  });
  assert.equal(await waitForCampaignPermit('sender','+919999999999'), false);
  assert.equal(calls, 1);
  assert.equal(keyCount, 4);
});
test('pair cooldown uses a recipient-specific Redis key', async () => {
  let key;
  const {setCampaignPairCooldown} = load('src/queues/campaignPacing.ts', {
    './campaignExecution.queue': {campaignExecutionQueue:{client:Promise.resolve({set:async value => {key=value;}})}},
    './campaignCapacity': {campaignCapacity:{}}
  });
  await setCampaignPairCooldown('sender','+91 99999 99999',6000);
  assert.equal(key,'campaign-send:{sender}:919999999999:cooldown');
});
for (const [status,state] of [['completed','completed'],['failed','failed'],['paused','delayed']]) {
  test(`rebroadcast replaces ${state} job for ${status} campaign`,async()=>{
    const {api,writes}=service(status,state);
    await api.reBroadcastCampaign('c');
    assert.equal(writes[0],'remove'); assert.equal(writes[1].status,'scheduled'); assert.equal(writes[2],'add');
  });
}
test('recovery marks only terminal failed jobs, leaving active and delayed retries alone',async()=>{
  const marked=[];
  const {reconcileFailedCampaignJobs}=load('src/app/services/campaignRecovery.ts',{
    '../models/campaign.model':{getRunningCampaigns:async()=>['failed','active','delayed'].map(id=>({id})),markRunningJobFailed:async (id,reason)=>marked.push({id,reason})},
    '../../queues/campaignExecution.queue':{campaignExecutionQueue:{getJob:async id=>({getState:async()=>id,failedReason:'Redis lock lost'})}}
  });
  await reconcileFailedCampaignJobs(); assert.deepEqual(marked,[{id:'failed',reason:'Redis lock lost'}]);
});
test('database pool exhaustion is classified as retryable infrastructure pressure', () => {
  const {isConnectionAcquireError} = load('src/queues/campaignDatabaseError.ts', {});
  assert.equal(isConnectionAcquireError(new Error('Knex: Timeout acquiring a connection. The pool is probably full.')), true);
  assert.equal(isConnectionAcquireError(new Error('Unable to acquire a connection')), true);
  assert.equal(isConnectionAcquireError({code:'53300',message:'too many clients already'}), true);
  assert.equal(isConnectionAcquireError(new Error('Template not found')), false);
});
