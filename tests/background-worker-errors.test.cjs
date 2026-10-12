const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const background = require('./helpers/background-database.cjs');
const failure = () => Object.assign(new Error('database unavailable'), { code: '42P01' });

function loadWorker(file, deps) {
  class Worker { constructor(_name, processor) { this.processor = processor; } on() { return this; } }
  class DelayedError extends Error {}
  deps.bullmq = { Worker, DelayedError };
  const exports = {};
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(js, { exports, require: id => {
    if (id.endsWith('/databaseErrors')) return background.databaseErrors;
    if (id.endsWith('/databaseAwareWorker')) return background.processorFactory(deps);
    return deps[id] || {};
  }, process, Date, console: { log() {}, info() {}, warn() {}, error() {} },
  setInterval: () => ({ unref() {} }), clearInterval() {} });
  return exports;
}

function campaignHarness({ missing = false, poolFailure = false } = {}) {
  let reads = 0, claims = 0, sends = 0, failureWrites = 0, delayed = 0;
  const error = poolFailure ? Object.assign(new Error('Timeout acquiring a connection'), { name: 'KnexTimeoutError' }) : failure();
  const campaign = { id: 'c', user_id: 'u', company_id: 'co', status: 'running', template_id: 't', phone_number_id: 'p' };
  const deps = {
    '../campaignExecution.queue': { campaignExecutionQueue: { client: Promise.resolve({ set: async () => 'OK', eval: async () => 1 }) } },
    '../campaignCapacity': { campaignCapacity: { concurrency: 1, messageConcurrency: 1 },
      createCapacitySampler: () => ({ sample: () => 3, metrics: () => ({}) }) },
    '../campaignPacing': { getCampaignSenderCooldown: async () => 0, waitForCampaignPermit: async () => true },
    '../campaignUserSlots': { acquireCampaignUserSlot: async () => true, releaseCampaignUserSlot: async () => {} },
    '../campaignDatabaseError': background.loadSource('src/queues/campaignDatabaseError.ts'),
    '../../app/utils/campaignPhone': { campaignRecipientNumber: value => value },
    '@surefy/console/app/utils/messageError': { getMessageError: e => ({ error_message: e.message }) },
    '@surefy/console/models/campaign.model': {
      findById: async () => { reads++; if (missing) throw error; return campaign; },
      updateStatus: async () => { failureWrites++; }, incrementCount: async () => { failureWrites++; },
    },
    '@surefy/console/models/campaignMessage.model': {
      getPendingMessages: async () => [1, 2, 3].map(id => ({ id, contact_id: id })),
      claimSingleAttempt: async () => { claims++; return true; },
      recordSent: async () => { throw error; },
      updateStatus: async () => { failureWrites++; },
    },
    '@surefy/console/models/contact.model': { findCampaignRecipients: async () => [1, 2, 3].map(id => ({ id, phone_number: '6581234567' })) },
    '@surefy/console/models/template.model': { findById: async () => ({ name: 't', language: 'en' }) },
    '../../app/models/phoneNumber.model': { findByPhoneNumberId: async () => ({ user_id: 'u', company_id: 'co', phone_number_id: 'p' }) },
    '@surefy/console/services/message.service': { sendMessage: async () => { sends++; return { id: 'm' }; } },
    uuid: { v4: () => 'lock' },
  };
  const api = loadWorker('src/queues/processors/campaignExecution.processor.ts', deps);
  const job = { id: 'job', data: { campaignId: 'c', companyId: 'co' }, opts: { attempts: 1 }, discard() {},
    moveToDelayed: async () => { delayed++; } };
  return { run: () => api.processCampaignExecution(job), error, get reads() { return reads; },
    get claims() { return claims; }, get sends() { return sends; }, get writes() { return failureWrites; }, get delayed() { return delayed; } };
}

test('a missing campaign schema stops after the first SELECT without further error-status queries', async () => {
  const h = campaignHarness({ missing: true });
  await assert.rejects(h.run(), error => error === h.error);
  assert.equal(h.reads, 1); assert.equal(h.writes, 0); assert.equal(h.sends, 0);
});

test('a database outage after an accepted campaign send preserves its reservation and stops the next recipient', async () => {
  const h = campaignHarness();
  await assert.rejects(h.run(), error => error.cause === h.error);
  assert.equal(h.claims, 1); assert.equal(h.sends, 1); assert.equal(h.writes, 0);
});

test('pool pressure defers campaign work after a send without consuming another recipient', async () => {
  const h = campaignHarness({ poolFailure: true });
  await assert.rejects(h.run());
  assert.equal(h.claims, 1); assert.equal(h.sends, 1); assert.equal(h.delayed, 1);
});

for (const beforeSend of [true, false]) {
  test(`bulk database failure stops later chunks and discards only after sends have begun: ${beforeSend}`, async () => {
    const sent = []; let discarded = 0;
    const error = failure();
    const api = loadWorker('src/queues/processors/bulkMessageSend.processor.ts', {
      '@surefy/console/app/models/user.model': { findById: async () => { if (beforeSend) throw error; return { id: 'u' }; } },
      '@surefy/console/services/message.service': { sendMessage: async data => {
        sent.push(data.to); if (data.to === '0') throw error;
        await new Promise(resolve => setImmediate(resolve)); return { id: 'message' };
      } },
    });
    await assert.rejects(api.bulkMessageSendWorker.processor({
      data: { userId: 'u', messages: [0, 1, 2, 3].map(to => ({ to: String(to), type: 'text' })) },
      discard() { discarded++; }, updateProgress: async () => assert.fail('failed batch cannot complete'),
    }), e => e === error);
    assert.deepEqual(sent, beforeSend ? [] : ['0', '1']); assert.equal(discarded, beforeSend ? 0 : 1);
  });
}
