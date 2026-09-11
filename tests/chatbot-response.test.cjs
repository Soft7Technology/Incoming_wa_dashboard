require('ts-node/register');
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {normalizeChatbotResponse: normalize} = require('../src/app/utils/chatbotResponse');
test('missing type defaults to text with supplied content', () => {
  assert.deepEqual(normalize({text:'hello'}),{type:'text',text:'hello'});
});
test('Meta text body is normalized to internal text', () => {
  assert.equal(normalize({type:'text',text:{body:'hello'}}).text,'hello');
});
test('null text can use a supplied body', () => {
  assert.equal(normalize({type:null,text:null,body:'hello'}).text,'hello');
});
test('empty responses and control signals cannot generate invalid payloads', () => {
  for (const value of [null,{}, {type:'text',text:null}, {text:'  '}, {ignoreMessage:true}]) assert.equal(normalize(value),null);
});
const {sendChatbotResponseBatch} = require('../src/app/utils/chatbotResponse');
test('text survives a following null action response', async () => {
  const sent=[];
  await sendChatbotResponseBatch({messages:[{type:'text',text:'Yes sir we have thanks'},null]},async message=>sent.push(message));
  assert.deepEqual(sent,[{type:'text',text:'Yes sir we have thanks'}]);
});
test('nested action messages are sent sequentially, skipping control responses', async () => {
  const sent=[];
  await sendChatbotResponseBatch({messages:[{text:'first'},{messages:[{ignoreMessage:true},{text:'second'}]}]},async message=>{
    await new Promise(resolve=>setTimeout(resolve,5)); sent.push(message.text);
  });
  assert.deepEqual(sent,['first','second']);
});
