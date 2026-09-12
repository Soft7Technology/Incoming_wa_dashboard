const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function setup(session, bot = { id: 'bot' }) {
  const writes = [];
  const logs = [];
  const exports = {};
  const dependencies = {
    bullmq: { Worker: class { on() { return this; } } },
    '@surefy/config/redis.config': {},
    '../chatbotDelay.queue': {},
    '../../app/models/chatSession.model': {
      findById: async () => session,
      update: async (id, data) => writes.push({ id, data }),
    },
    '../../app/services/chatbot/runtimeBot': { getRuntimeBot: async () => bot },
    '../../app/models/chatBotNode.model': { findByChatBotId: async () => [{ id: 'next', data: {} }] },
    '../../app/models/chatBotEdge.model': { findByChatBotId: async () => [{ source: 'delay', target: 'next' }] },
    '../../app/services/chatbot/engine/executeNode': {
      executeNode: async () => ({ type: 'text', text: 'hello' }), endSession: async () => {},
    },
    '../../app/services/message.service': {
      sendChatBotMessage: async (...args) => writes.push({ send: args }),
    },
  };
  const js = ts.transpileModule(fs.readFileSync('src/queues/processors/chatbotDelay.processor.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(js, {
    exports, require: id => dependencies[id] || {}, process,
    console: { info: (...args) => logs.push(args), warn: (...args) => logs.push(args), error() {} },
  });
  return { resume: exports.resumeChatbotDelay, writes, logs };
}

const data = { sessionId: 'session', nodeId: 'delay', token: 'token' };

test('delay worker resumes an active session and sends the next response', async () => {
  const { resume, writes } = setup({ id: 'session', active: true, current_node_id: 'delay',
    phoneNumberId: 'meta-phone', phone_number: '+123', chatbot_id: 'bot', variables: { chatbot_delay_token: 'token' } });
  await resume(data);
  assert.equal(writes[0].data.current_node_id, 'next');
  assert.equal(writes[0].data.variables.chatbot_delay_token, undefined);
  assert.equal(writes[1].send[0], 'meta-phone');
});

test('delay worker logs and skips a stale session', async () => {
  const { resume, writes, logs } = setup({ id: 'session', active: true, current_node_id: 'other', variables: { chatbot_delay_token: 'token' } });
  await resume(data);
  assert.equal(writes.length, 0);
  assert.ok(logs.some(([message]) => message.includes('Skipped stale')));
});

test('delay worker fails visibly when an active bot mapping is missing', async () => {
  const { resume } = setup({ id: 'session', active: true, current_node_id: 'delay', phoneNumberId: 'meta-phone',
    chatbot_id: 'bot', variables: { chatbot_delay_token: 'token' } }, null);
  await assert.rejects(resume(data), /mapping not found/);
});
