const {test}=require('node:test');
const assert=require('node:assert/strict');
const ts=require('typescript');
const fs=require('node:fs');
const vm=require('node:vm');
function load(file,deps) {
  const exports={};
  const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText;
  vm.runInNewContext(js,{exports,require:id=>deps[id]||{},console:{log(){},info(){},warn(){},error(){}},process:{env:{}}});
  return exports;
}
function handler({keyword=null,session=null,sessionBot=null,defaultBot={id:'default',isDefault:true}}={}) {
  const lookups=[],routed=[],sent=[];
  const api=load('src/app/services/chatbot/chatbot.service.ts',{
    './runtimeBot':{getRuntimeBot:async (phone,id,text,defaultOnly)=>{
      lookups.push({id,text,defaultOnly}); return defaultOnly?defaultBot:id?sessionBot:keyword;
    }},
    '@surefy/console/app/models/chatSession.model':{findActiveByPhoneNumberId:async()=>session,deactivateOtherBots:async()=>{}},
    './flow.route':{flowRouter:async args=>{routed.push(args);return {text:'started'}}},
    '@surefy/console/services/message.service':{sendChatBotMessage:async(...args)=>sent.push(args)},
    '@surefy/console/models/contact.model':{findOrCreateIncoming:async()=>{}},
    '../../models/phoneNumber.model':{findByPhoneNumberId:async()=>({id:'phone',user_id:'user'})},
    '../../models/user.model':{findByPhone:async()=>null},
    nodemailer:{createTransport:()=>({})}
  });
  return {run:message=>api.handleIncomingMessageChatBot('meta',{from:'sender',...message},'Name'),lookups,routed,sent};
}
test('unmatched text starts default flow',async()=>{
  const h=handler(); await h.run({text:{body:'anything at all'}});
  assert.equal(h.routed[0].bot.id,'default'); assert.equal(h.routed[0].triggerMatched,true); assert.equal(h.sent.length,1);
});
test('active conversation continues without default lookup or restart',async()=>{
  const h=handler({session:{chatbot_id:'active'},sessionBot:{id:'active'}});
  await h.run({text:{body:'answer'}});
  assert.equal(h.routed[0].bot.id,'active'); assert.equal(h.routed[0].triggerMatched,false);
  assert.equal(h.lookups.some(x=>x.defaultOnly),false);
});
test('keyword flow takes priority over default',async()=>{
  const h=handler({keyword:{id:'keyword'}}); await h.run({text:{body:'hello'}});
  assert.equal(h.routed[0].bot.id,'keyword'); assert.equal(h.lookups.length,1);
});
test('no default or nontext messages do not start a flow',async()=>{
  const h=handler({defaultBot:null}); await h.run({text:{body:'hello'}}); assert.equal(h.routed.length,0);
  for(const message of [{image:{id:'image'}},{text:{body:'   '}},{interactive:{button_reply:{id:'x',title:'Reply'}}}]) {
    const h=handler(); await h.run(message); assert.equal(h.routed.length,0);
  }
});
test('default starts for numeric text without FPO registration lookup',async()=>{
  let executed=false;
  const api=load('src/app/services/chatbot/flows/trigger.flow.ts',{
    '../runtimeBot':{getRuntimeBot:async(phone,id,text,defaultOnly)=>{assert.equal(defaultOnly,true);return {id:'default'}}},
    '@surefy/console/app/models/user.model':{findByPhone:async()=>{throw Error('Unexpected FPO lookup')}},
    '@surefy/console/app/models/chatSession.model':{findActiveSession:async()=>null,deactivateActiveSession:async()=>{},create:async()=>({id:'session'})},
    '../engine/executeNode':{executeNode:async()=>{executed=true;return {text:'welcome'}}}
  });
  await api.triggerFlow({bot:{id:'default',isDefault:true,nodes:[{id:'t',type:'trigger'},{id:'m',type:'message'}],edges:[{source:'t',target:'m'}]},phone:'sender',phoneNumberId:'meta',incomingText:'9876543210'});
  assert.equal(executed,true);
});
test('default flow can be published and publication checks default conflicts',async()=>{
  let published=false;
  let conflicts=[];
  const api=load('src/app/services/chatbot.service.ts',{
    '../models/chatbot.model':{findById:async()=>({user_id:'user'}),setPublishedState:async(id,value)=>{published=value}},
    '../models/chatbotTrigger.model':{findAll:async()=>[{phone_number_id:'meta',trigger_word:''}],findConflicts:async args=>{assert.equal(args.triggers[0],'');return conflicts}},
    '@surefy/exceptions/HTTP400Error':class extends Error{constructor(data){super(data.message)}}
  }).default;
  await api.publishedChatBot('user','bot'); assert.equal(published,true);
  published=false; conflicts=[{chatbot_id:'other'}];
  await assert.rejects(api.publishedChatBot('user','bot'),/default chatbot is already assigned/);
  assert.equal(published,false);
});
test('mapping lookup separates default, keyword and session queries',async()=>{
  const filters=[];
  const query={where:value=>{filters.push(value);return query},whereIn:()=>query,whereRaw:(sql,args)=>{filters.push(args);return query},orderBy:()=>query,first:async()=>({chatbot_id:'bot'})};
  const api=load('src/app/models/chatbotTrigger.model.ts',{'@surefy/models/base.model':{BaseModel:class{query(){return query}}}}).default;
  await api.findRuntimeMapping(['meta'],undefined,undefined,true);
  assert.ok(filters.some(x=>x.trigger_word===''));
  filters.length=0;
  await api.findRuntimeMapping(['meta'],undefined,' Hello  world ');
  assert.ok(filters.some(x=>Array.isArray(x)&&x[0]==='hello world'));
  assert.equal(filters.some(x=>x.trigger_word===''),false);
  filters.length=0;
  await api.findRuntimeMapping(['meta'],'bot');
  assert.ok(filters.some(x=>x.chatbot_id==='bot'));
  assert.equal(await api.findRuntimeMapping(['meta'],undefined,'  '),null);
});
