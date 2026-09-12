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
  assert.equal(nextBatchSize(4,.2,.84,10,10),5);
  assert.equal(nextBatchSize(10,.2,.96,10,10),5);
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
    '../models/campaign.model':{getRunningCampaigns:async()=>['failed','active','delayed'].map(id=>({id})),completeIfNoPendingMessages:async()=>false,markRunningJobFailed:async (id,reason)=>marked.push({id,reason})},
    '../../queues/campaignExecution.queue':{campaignExecutionQueue:{getJob:async id=>({getState:async()=>id,failedReason:'Redis lock lost'})}}
  });
  await reconcileFailedCampaignJobs(); assert.deepEqual(marked,[{id:'failed',reason:'Redis lock lost'}]);
});
test('recovery requeues a running campaign whose BullMQ job is missing',async()=>{
  const added=[];
  const {reconcileFailedCampaignJobs}=load('src/app/services/campaignRecovery.ts',{
    '../models/campaign.model':{getRunningCampaigns:async()=>[{id:'c',user_id:'u',company_id:'co'}]},
    '../../queues/campaignExecution.queue':{campaignExecutionQueue:{getJob:async()=>null,add:async(name,data,options)=>added.push({name,data,options})}}
  });
  await reconcileFailedCampaignJobs();
  assert.deepEqual(JSON.parse(JSON.stringify(added)),[{name:'campaign-c',data:{campaignId:'c',userId:'u',companyId:'co'},options:{jobId:'c'}}]);
});

test('recovery completes a campaign with no pending messages even when its job failed',async()=>{
  const writes=[];
  const {reconcileFailedCampaignJobs}=load('src/app/services/campaignRecovery.ts',{
    '../models/campaign.model':{
      getRunningCampaigns:async()=>[{id:'c'}],
      completeIfNoPendingMessages:async id=>{writes.push(['complete',id]);return true;},
      markRunningJobFailed:async()=>writes.push(['failed']),
    },
    '../../queues/campaignExecution.queue':{campaignExecutionQueue:{getJob:async()=>({id:'c',getState:async()=> 'failed'})}}
  });
  await reconcileFailedCampaignJobs();
  assert.deepEqual(writes,[['complete','c']]);
});

test('database pool exhaustion is classified as retryable infrastructure pressure', () => {
  const {isConnectionAcquireError} = load('src/queues/campaignDatabaseError.ts', {});
  assert.equal(isConnectionAcquireError(new Error('Knex: Timeout acquiring a connection. The pool is probably full.')), true);
  assert.equal(isConnectionAcquireError(new Error('Unable to acquire a connection')), true);
  assert.equal(isConnectionAcquireError({code:'53300',message:'too many clients already'}), true);
  assert.equal(isConnectionAcquireError(new Error('Template not found')), false);
});
test('campaign waits for deferred recipients instead of completing early', async () => {
  class DelayedError extends Error {}
  const delayed=[];
  const updates=[];
  const redis={set:async()=> 'OK',eval:async()=>1};
  class Worker { on() { return this; } }
  const {processCampaignExecution}=load('src/queues/processors/campaignExecution.processor.ts',{
    'bullmq':{Worker,DelayedError},
    '../campaignExecution.queue':{campaignExecutionQueue:{client:Promise.resolve(redis)}},
    '../campaignCapacity':{campaignCapacity:{concurrency:1,messageConcurrency:1,maxRunningPerUser:1,messagesPerSecond:10},createCapacitySampler:()=>({sample:()=>1,metrics:()=>({}),close(){}})},
    '../campaignPacing':{getCampaignSenderCooldown:async()=>0},
    '../campaignUserSlots':{acquireCampaignUserSlot:async()=>true,releaseCampaignUserSlot:async()=>{}},
    '../campaignDatabaseError':{isConnectionAcquireError:()=>false},
    '../../app/models/phoneNumber.model':{findByPhoneNumberId:async()=>({phone_number_id:'p'})},
    '@surefy/console/models/campaign.model':{findById:async()=>({id:'c',company_id:'co',user_id:'u',status:'running',template_id:'t',phone_number_id:'p'}),updateStatus:async(...args)=>updates.push(args)},
    '@surefy/console/models/campaignMessage.model':{getPendingMessages:async()=>[],getNextRetryAt:async()=>new Date(Date.now()+6000)},
    '@surefy/console/models/template.model':{findById:async()=>({id:'t'})},
    '@surefy/config/redis.config':{},
    'uuid':{v4:()=> 'lock-owner'}
  });
  await assert.rejects(processCampaignExecution({id:'c',data:{campaignId:'c',companyId:'co'},timestamp:Date.now(),moveToDelayed:async at=>delayed.push(at)}),DelayedError);
  assert.equal(updates.length,0);
  assert.ok(delayed[0]>Date.now());
});

test('a recipient exhausting ten pair-limit retries does not stop the next send', async () => {
  class DelayedError extends Error {}
  class Worker { on() { return this; } }
  const sent=[]; const statuses=[];
  const redis={set:async()=> 'OK',eval:async()=>1};
  const {processCampaignExecution}=load('src/queues/processors/campaignExecution.processor.ts',{
    'bullmq':{Worker,DelayedError},
    '../campaignExecution.queue':{campaignExecutionQueue:{client:Promise.resolve(redis)}},
    '../campaignCapacity':{campaignCapacity:{concurrency:1,messageConcurrency:2,maxRunningPerUser:1,messagesPerSecond:10,yieldMs:250},createCapacitySampler:()=>({sample:()=>2,metrics:()=>({}),close(){}})},
    '../campaignPacing':{getCampaignSenderCooldown:async()=>0,waitForCampaignPermit:async()=>true,setCampaignPairCooldown:async()=>{}},
    '../campaignUserSlots':{acquireCampaignUserSlot:async()=>true,releaseCampaignUserSlot:async()=>{}},
    '../campaignDatabaseError':{isConnectionAcquireError:()=>false},
    '../../app/models/phoneNumber.model':{findByPhoneNumberId:async()=>({phone_number_id:'p'})},
    '@surefy/console/models/campaign.model':{findById:async()=>({id:'c',company_id:'co',user_id:'u',status:'running',template_id:'t',phone_number_id:'p'}),incrementCount:async()=>{throw new Error('counter unavailable');}},
    '@surefy/console/models/campaignMessage.model':{getPendingMessages:async()=>[{id:'one',contact_id:'one'},{id:'two',contact_id:'two'}],deferRetry:async()=>10,updateStatus:async(id,status)=>statuses.push([id,status]),recordSent:async()=>{}},
    '@surefy/console/models/contact.model':{findCampaignRecipients:async()=>[{id:'one',phone_number:'+111',is_valid:true},{id:'two',phone_number:'+222',is_valid:true}],incrementFailedCount:async()=>{throw new Error('counter unavailable');}},
    '@surefy/console/models/template.model':{findById:async()=>({id:'t'})},
    '@surefy/console/services/message.service':{sendMessage:async data=>{sent.push(data.to);if(data.to==='+111')throw {code:131056,message:'pair limit'};return {id:'message'};}},
    '@surefy/console/app/utils/messageError':{getMessageError:error=>({error_code:String(error.code||'UNKNOWN'),error_message:error.message||'error'})},
    '@surefy/config/redis.config':{},
    'uuid':{v4:()=> 'lock-owner'}
  });
  await assert.rejects(processCampaignExecution({id:'c',data:{campaignId:'c',companyId:'co',progressCheckedAt:Date.now()},opts:{attempts:3},timestamp:Date.now(),updateData:async()=>{},log:async()=>{},moveToDelayed:async()=>{}}),DelayedError);
  assert.deepEqual(sent,['+111','+222']);
  assert.deepEqual(statuses,[['one','failed']]);
});
test('bulk sends cannot flood the shared campaign database pool', async () => {
  let active=0, peak=0;
  class Worker { constructor(_,processJob){this.processJob=processJob;} on(){return this;} }
  const {bulkMessageSendWorker}=load('src/queues/processors/bulkMessageSend.processor.ts',{
    'bullmq':{Worker},
    '@surefy/console/app/models/user.model':{findById:async()=>({id:'u'})},
    '@surefy/console/services/message.service':{sendMessage:async()=>{
      active++; peak=Math.max(peak,active);
      await new Promise(resolve=>setTimeout(resolve,5));
      active--; return {id:'m'};
    }}
  });
  const result=await bulkMessageSendWorker.processJob({data:{userId:'u',messages:Array.from({length:5},(_,i)=>({to:String(i),phone_number_id:'p',type:'text'}))},updateProgress:async()=>{}});
  assert.equal(result.successful,5);
  assert.ok(peak<=2);
});
