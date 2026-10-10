require('ts-node/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const mediaHelpers = require('../src/app/utils/chatbotMessage');
const responseHelpers = require('../src/app/utils/chatbotResponse');
const delayHelpers = require('../src/app/utils/chatbotDelay');

function load(file, dependencies = {}) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(source, {
    exports, require: id => dependencies[id] || {}, process: { env: {} },
    console: { log() {}, info() {}, warn() {}, error() {} }, Date,
  });
  return exports;
}

function responseBuilder() {
  return load('src/app/utils.ts', {
    './utils/chatbotMessage': mediaHelpers,
    nodemailer: { createTransport: () => ({}) },
  }).buildResponse;
}

const audio = link => ({ type: 'audio', audio: { link } });
const audioNode = (id, link) => ({ id, data: {
  key: '@whatsapp/send-media-message', attributes: { message: audio(link) },
} });

test('audio nodes retain audio.link through building, normalization, sending and storage', async () => {
  const payloads = [], saved = [];
  const sender = load('src/app/services/message.service.ts', {
    '../utils/chatbotResponse': responseHelpers,
    '../utils/chatbotMessage': mediaHelpers,
    '@surefy/console/models/phoneNumber.model': { findByPhoneNumberId: async () => ({
      id: 'number', user_id: 'owner', company_id: 'company', display_phone_number: '123',
    }) },
    '@surefy/console/services/meta.service': { sendMessage: async (phone, payload) => {
      payloads.push({ phone, payload });
      return { messages: [{ id: 'wamid-audio' }] };
    } },
    '@surefy/console/models/message.model': { create: async record => { saved.push(record); return record; } },
  }).default;
  const response = await responseBuilder()(audioNode('audio', 'https://example.com/recording.mp3'));
  await sender.sendChatBotMessage('meta-number', 'recipient', response, 'incoming-id');
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].payload.type, 'audio');
  assert.equal(payloads[0].payload.audio.link, 'https://example.com/recording.mp3');
  assert.equal(payloads[0].payload.image, undefined);
  assert.equal(payloads[0].payload.context.message_id, 'incoming-id');
  assert.equal(saved[0].type, 'audio');
  assert.equal(saved[0].content.audio.link, payloads[0].payload.audio.link);
});

test('video and document nodes preserve their media fields and uploaded media IDs', async () => {
  const build = responseBuilder();
  for (const message of [
    { type: 'image', image: { link: 'https://example.com/image.jpg', caption: 'Photo' } },
    { type: 'video', video: { link: 'https://example.com/video.mp4', caption: 'Video' } },
    { type: 'document', document: { id: 'uploaded-id', caption: 'Guide', filename: 'guide.pdf' } },
    { type: 'sticker', sticker: { id: 'sticker-id' } },
  ]) {
    const response = await build({ data: { key: '@whatsapp/send-media-message', attributes: { message } } });
    assert.deepEqual(JSON.parse(JSON.stringify(response)), message);
  }
});

test('invalid or ambiguous media is rejected instead of sending an empty attachment', () => {
  for (const message of [
    { type: 'audio', audio: { link: '' } },
    { type: 'audio', image: { link: 'https://example.com/incorrect.mp3' } },
    { type: 'video', video: { link: 'https://example.com/video.mp4', id: 'also-id' } },
    { type: 'unknown' },
  ]) {
    assert.throws(() => mediaHelpers.validateChatbotMessage({
      key: '@whatsapp/send-media-message', attributes: { message },
    }), /Media|media/);
  }
  assert.deepEqual(mediaHelpers.buildChatbotMediaMessage({ type: 'audio', audio: {
    link: 'https://example.com/audio.mp3', caption: 'Unsupported caption',
  } }), audio('https://example.com/audio.mp3'));
});

function engineHarness(queueError) {
  const writes = [], jobs = [];
  const engine = load('src/app/services/chatbot/engine/executeNode.ts', {
    '@surefy/console/utils': { buildResponse: responseBuilder() },
    '@surefy/console/app/models/chatSession.model': { update: async (id, data) => writes.push({ id, data }) },
    '../../../utils/chatbotDelay': delayHelpers,
    crypto: { randomUUID: () => 'delay-token' },
    '../../../../queues/chatbotDelay.queue': { chatbotDelayQueue: {
      add: async (...args) => {
        if (queueError) throw queueError;
        jobs.push(args);
      },
    } },
  });
  return { ...engine, writes, jobs };
}

test('first audio automatically schedules exactly five minutes, then stops at the delay', async () => {
  const h = engineHarness();
  const first = audioNode('audio1', 'https://example.com/first.mp3');
  const delay = { id: 'delay', data: { key: '@whatsapp/delay', attributes: { delay: 300000 } } };
  const next = audioNode('audio2', 'https://example.com/second.mp3');
  const bot = { nodes: [first, delay, next], edges: [
    { source: 'audio1', target: 'delay' }, { source: 'delay', target: 'audio2' },
  ] };
  const result = await h.executeNode({ bot, session: { id: 'session', variables: { name: 'Customer' } }, currentNode: first });
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].audio.link, 'https://example.com/first.mp3');
  assert.equal(h.jobs.length, 1);
  assert.equal(h.jobs[0][2].delay, 300000);
  assert.equal(h.jobs[0][1].nodeId, 'delay');
  assert.equal(h.writes.at(-1).data.variables.chatbot_delay_token, 'delay-token');
  assert.equal(h.writes.at(-1).data.variables.name, 'Customer');
});

test('one-minute delay queues 60000ms, and a Redis failure ends the waiting session visibly', async () => {
  const delay = { id: 'delay', data: { key: '@whatsapp/delay', attributes: { delay: 60000 } } };
  const args = { bot: {}, session: { id: 'session' }, currentNode: delay };
  const h = engineHarness();
  assert.equal((await h.executeNode(args)).ignoreMessage, true);
  assert.equal(h.jobs[0][2].delay, 60000);
  const failed = engineHarness(new Error('Redis connection unavailable'));
  await assert.rejects(failed.executeNode(args), /Redis connection unavailable/);
  assert.equal(failed.writes.at(-1).data.active, false);
  assert.equal(failed.writes.at(-1).data.current_node_id, null);
  assert.equal(failed.jobs.length, 0);
});

test('after a delay the recording link and second audio are sent in order without another inbound message', async () => {
  const h = engineHarness();
  const text = { id: 'text', data: { key: '@whatsapp/send-text-message', attributes: {
    message: { text: { body: 'Watch the meeting recording' } },
  } } };
  const next = audioNode('audio2', 'https://example.com/second.mp3');
  const bot = { nodes: [text, next], edges: [{ source: 'text', target: 'audio2' }] };
  const result = await h.executeNode({ bot, session: { id: 'session' }, currentNode: text });
  const sent = [];
  await responseHelpers.sendChatbotResponseBatch(result, async message => sent.push(message));
  assert.equal(sent.length, 2);
  assert.equal(sent[0].text, 'Watch the meeting recording');
  assert.equal(sent[1].audio.link, 'https://example.com/second.mp3');
  assert.equal(h.writes.at(-1).data.active, false);
});

test('the Community Link button waits for a click before starting audio or a delay', async () => {
  const h = engineHarness();
  const button = { id: 'button', data: { key: '@whatsapp/send-button-message', attributes: {
    message: { interactive: { body: { text: 'Join our community' }, action: {
      buttons: [{ type: 'reply', reply: { id: 'community', title: 'Community Link' } }],
    } } },
  } } };
  const first = audioNode('audio1', 'https://example.com/first.mp3');
  const result = await h.executeNode({ bot: { nodes: [button, first], edges: [
    { source: 'button', target: 'audio1', sourceHandle: 'community' },
  ] }, session: { id: 'session' }, currentNode: button });
  assert.equal(result.type, 'interactive');
  assert.equal(h.jobs.length, 0);
  assert.equal(h.writes.length, 0);
});
