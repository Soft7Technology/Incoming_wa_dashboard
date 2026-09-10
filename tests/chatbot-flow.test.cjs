const {test} = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const fs = require('node:fs');
const vm = require('node:vm');
function setup(conflicts) {
  const writes=[]; const bot={id:'bot',user_id:'user',published:false,name:'Bot'};
  function trx(table) { const q={where(){return q},whereIn(){return q},whereNot(){return q},whereRaw(){return q},forUpdate(){return q},first:async()=>bot,select:async()=>conflicts,update:async data=>writes.push({table,data}),delete:async()=>writes.push({table,deleted:true}),insert:async data=>writes.push({table,data})}; return q; }
  trx.raw=async()=>{};
  const deps={'@surefy/database':{transaction:async fn=>fn(trx)},'../models/chatbot.model':{findById:async()=>bot},'../models/phoneNumber.model':{findByPhoneNumberId:async()=>({id:'uuid',phone_number_id:'meta',user_id:'user'})},'uuid':{v4:()=> 'generated'},'@surefy/exceptions/HTTP400Error':class extends Error{constructor(data){super(data.message);this.details=data.details}}};
  const exports={};
  const js=ts.transpileModule(fs.readFileSync('src/app/services/chatbot.service.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText;
  vm.runInNewContext(js,{exports,require:id=>deps[id]||{},console:{log(){}},Date});
  return {api:exports.default,writes};
}
const payload={chatBotId:'bot',phoneNumberIds:['uuid','meta'],nodes:[{id:'t',type:'trigger',data:{attributes:{keywords:[' HI ','hi']}}},{id:'m',type:'message',data:{}}],edges:[{source:'t',target:'m'}]};
test('conflicting keyword rejects before any flow writes',async()=>{
  const {api,writes}=setup([{chatbot_id:'other',trigger_word:'hi'}]);
  await assert.rejects(api.createFlow('user',payload),/already assigned/);
  assert.equal(writes.length,0);
});
test('deduplicates keywords and phone aliases before inserting',async()=>{
  const {api,writes}=setup([]); await api.createFlow('user',payload);
  const inserted=writes.filter(w=>w.table==='chatbot_triggers' && w.data);
  assert.equal(inserted.length,1); assert.equal(inserted[0].data.phone_number_id,'meta'); assert.equal(inserted[0].data.trigger_word,'hi');
});

