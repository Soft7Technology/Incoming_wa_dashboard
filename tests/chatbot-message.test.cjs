require('ts-node/register');
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {validateChatbotMessage} = require('../src/app/utils/chatbotMessage');
test('rejects the blank list row from the reported payload', () => {
  assert.throws(() => validateChatbotMessage({key:'@whatsapp/send-list-message',attributes:{message:{interactive:{action:{sections:[{rows:[{id:'row_0',title:''}]}]}}}}}), /option 1: title is required/);
});
test('accepts a text node without interactive fields', () => {
  assert.doesNotThrow(() => validateChatbotMessage({key:'@whatsapp/send-text-message',attributes:{message:{text:{body:'hello'}}}}));
});
test('accepts a named list option', () => {
  assert.doesNotThrow(() => validateChatbotMessage({key:'@whatsapp/send-list-message',attributes:{message:{interactive:{action:{sections:[{rows:[{id:'row_0',title:'Support'}]}]}}}}}));
});
