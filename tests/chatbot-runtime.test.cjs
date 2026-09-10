const {test} = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const fs = require('node:fs');
const vm = require('node:vm');
function runtime(mapping, owner = 'user', creatorCompany = 'other-company') {
  const dependencies = {
    '../../models/user.model': { findById: async () => ({ company_id: creatorCompany }) },
    '../../models/chatbotTrigger.model': { findRuntimeMapping: async () => mapping },
    '../../models/phoneNumber.model': { findByPhoneNumberId: async () => ({ user_id:'user', company_id:'company' }) },
    '../../models/chatBotEdge.model': { findByChatBotId: async () => [{source:'trigger',target:'reply'}] },
    '../../models/chatBotNode.model': { findByChatBotId: async () => [{type:'trigger',user_id:owner}, ...Array(3).fill({type:'message'})] }
  };
  const exports = {};
  const js = ts.transpileModule(fs.readFileSync('src/app/services/chatbot/runtimeBot.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
  vm.runInNewContext(js,{exports,console:{info(){},warn(){}},require(id){assert.ok(dependencies[id], 'Unexpected runtime dependency: '+id); return dependencies[id];}});
  return exports.getRuntimeBot;
}
test('runtime resolves active mapping and flow type without chat_bot reads', async () => {
  const bot = await runtime({chatbot_id:'bot'})('phone');
  assert.equal(bot.id,'bot'); assert.equal(bot.user_id,'user'); assert.equal(bot.flow_type,'form'); assert.equal(bot.edges[0].target,'reply'); assert.equal(bot.nodes.length,4);
});
test('inactive/unmapped bots do not run', async () => {
  assert.equal(await runtime(null)('phone','bot'),null);
});
test('phone mapping cannot run another owners flow', async () => {
  assert.equal(await runtime({chatbot_id:'bot'},'another-user')('phone'),null);
});

test('company member flow can run on the company receiving number', async () => {
  const bot = await runtime({chatbot_id:'bot'}, 'member', 'company')('meta-id');
  assert.equal(bot.id, 'bot');
});
