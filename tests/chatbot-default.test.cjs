require('ts-node/register');
require('tsconfig-paths/register');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const ts=require('typescript');
const fs=require('node:fs');
const vm=require('node:vm');
function load(file,deps) {
  const exports={};
  const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText;
  vm.runInNewContext(js,{exports,require:id=>deps[id] || (id.endsWith('/interactiveChoice')
    ? require('../src/app/services/chatbot/interactiveChoice') : {}),console:{log(){},info(){},warn(){},error(){}},process:{env:{}}});
  return exports;
}
function handler({keyword=null,session=null,sessionBot=null,defaultBot={id:'default',isDefault:true}}={}) {
  const lookups=[],routed=[],sent=[];
  const api=load('src/app/services/chatbot/chatbot.service.ts',{
    './runtimeBot':{getRuntimeBot:async (phone,id,text,defaultOnly)=>{
      lookups.push({phone,id,text,defaultOnly}); return defaultOnly?defaultBot:id?sessionBot:keyword;
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

test('default button flow responds again to arbitrary text and follows the selected button',async()=>{
  const executed=[];
  const api=load('src/app/services/chatbot/flows/menu.flow.ts',{
    '@surefy/console/app/models/chatSession.model':{update:async()=>{}},
    '@surefy/console/services/chatbot/engine/executeNode':{executeNode:async args=>{executed.push(args);return {text:'response'}}}
  });
  const bot={isDefault:true,nodes:[{id:'menu',data:{key:'@whatsapp/send-button-message'}},{id:'tag'},{id:'column'}],edges:[
    {source:'menu',target:'tag',data:{buttonId:'tag'}},
    {source:'menu',target:'column',data:{button_id:'columns'}}
  ]};
  const session={id:'session',current_node_id:'menu',variables:{user_id:'owner'}};
  await api.menuFlow({bot,session,incomingText:'any new text'});
  assert.equal(executed[0].currentNode.id,'menu');
  await api.menuFlow({bot,session,incomingId:'columns',incomingText:'columns'});
  assert.equal(executed[1].currentNode.id,'column');
  assert.equal(executed[1].session.variables.user_id,'owner');
  bot.isDefault=false;
  assert.equal((await api.menuFlow({bot,session,incomingText:'unmatched'})).ignoreMessage,true);
  assert.equal(executed.length,2);
});
test('default question answers continue the flow and delay waits stay paused',async()=>{
  const executed=[];
  const api=load('src/app/services/chatbot/flows/menu.flow.ts',{
    '@surefy/console/app/models/chatSession.model':{update:async()=>{}},
    '@surefy/console/services/chatbot/engine/executeNode':{executeNode:async args=>{executed.push(args);return {text:'response'}}}
  });
  const bot={isDefault:true,nodes:[{id:'question',data:{key:'@whatsapp/ask-question',attributes:{variable:'answer'}}},{id:'next'}],edges:[{source:'question',target:'next'}]};
  const session={id:'session',current_node_id:'question',variables:{}};
  await api.menuFlow({bot,session,incomingText:'my answer'});
  assert.equal(executed[0].session.variables.answer,'my answer');
  assert.equal(executed[0].currentNode.id,'next');
  session.variables.chatbot_delay_token='pending';
  assert.equal((await api.menuFlow({bot,session,incomingText:'hello'})).ignoreMessage,true);
  assert.equal(executed.length,1);
});
test('default flow restarts immediately when an existing session refers to a deleted node',async()=>{
  let starts=0,resets=0;
  const api=load('src/app/services/chatbot/flow.route.ts',{
    '../../models/chatSession.model':{findActiveSession:async()=>({current_node_id:'old-node'}),deactivateActiveSession:async()=>{resets++}},
    './flows/trigger.flow':{triggerFlow:async()=>{starts++;return {text:'welcome'}}},
    './flows/menu.flow':{menuFlow:async()=>{throw Error('Stale node must not reach menu')}}
  });
  await api.flowRouter({bot:{id:'default',isDefault:true,nodes:[{id:'new-node'}]},phone:'sender',phoneNumberId:'meta',incomingText:'hello'});
  assert.equal(starts,1);assert.equal(resets,1);
});

for (const [label, reply, expectedId] of [
  ['interactive button', {interactive:{button_reply:{id:'button-1',title:'  SUPPORT  '}}}, 'button-1'],
  ['template quick reply', {button:{payload:'opaque-payload',text:'  SUPPORT  '}}, 'opaque-payload'],
  ['list reply', {interactive:{list_reply:{id:'row-1',title:'  SUPPORT  '}}}, 'row-1'],
]) {
  test(label + ' without a connected active choice can select the receiving phones keyword flow', async () => {
    const h=handler({keyword:{id:'support'},session:{chatbot_id:'old'},sessionBot:{id:'old'}});
    await h.run(reply);
    assert.equal(h.lookups.length,2);
    assert.equal(h.lookups[0].id,'old');
    assert.equal(h.lookups[1].phone,'meta');
    assert.equal(h.lookups[1].text,'support');
    assert.equal(h.routed[0].bot.id,'support');
    assert.equal(h.routed[0].triggerMatched,true);
    assert.equal(h.routed[0].incomingId,expectedId);
    assert.equal(h.sent.length,1);
  });
  test(label + ' without a keyword match continues its active session', async () => {
    const h=handler({session:{chatbot_id:'active'},sessionBot:{id:'active'}});
    await h.run(reply);
    assert.equal(h.routed[0].bot.id,'active');
    assert.equal(h.routed[0].triggerMatched,false);
    assert.equal(h.routed[0].incomingId,expectedId);
    assert.equal(h.lookups.some(x=>x.defaultOnly),false);
  });
  for (const field of ['sourceHandle', 'data.sourceHandle', 'data.buttonId', 'data.button_id']) {
    test(label + ' follows its active connection before a colliding keyword using ' + field, async () => {
      const edge = {source:'menu',target:'services'};
      if (field === 'sourceHandle') edge.sourceHandle=expectedId;
      else edge.data={[field.slice(5)]:expectedId};
      const h=handler({keyword:{id:'keyword'},session:{chatbot_id:'active',current_node_id:'menu'},
        sessionBot:{id:'active',nodes:[{id:'menu'},{id:'services'}],edges:[edge]}});
      await h.run(reply);
      assert.equal(h.lookups.length,1);
      assert.equal(h.lookups[0].id,'active');
      assert.equal(h.routed[0].bot.id,'active');
      assert.equal(h.routed[0].triggerMatched,false);
      assert.equal(h.routed[0].incomingId,expectedId);
      assert.equal(h.sent.length,1);
    });
  }
}

test('a button from another node or a deleted target does not override keyword routing', async () => {
  for (const edge of [{source:'other-node',target:'services',sourceHandle:'choice'},
    {source:'menu',target:'deleted',sourceHandle:'choice'}]) {
    const h=handler({keyword:{id:'keyword'},session:{chatbot_id:'active',current_node_id:'menu'},
      sessionBot:{id:'active',nodes:[{id:'menu'},{id:'services'}],edges:[edge]}});
    await h.run({interactive:{button_reply:{id:'choice',title:'Support'}}});
    assert.equal(h.routed[0].bot.id,'keyword');
    assert.equal(h.routed[0].triggerMatched,true);
  }
});

test('DoveKnot Services clicks follow Welcome and Quote connections without restarting or rewriting the graph', async () => {
  const welcome='15d05532-e31f-4833-89c3-e737356e06af';
  const services='cb3d90d7-bf3b-4a16-8ceb-8b55f9696568';
  const quote='33ebc7e7-dc90-4277-ae47-6273d0553507';
  const welcomeServices='btn_cc78c472-8539-4bc8-8c6b-94a0b3f46182_0';
  const quoteServices='btn_1526f6d0-db22-4853-bc1d-c0a1819885a0_54b9bb0a-c576-4222-9cb0-ee169b81192b';
  const getQuote='btn_cebf55a2-0017-4cac-9fbd-213ec209929a_0';
  const bot={id:'doveknot',user_id:'owner',nodes:[
    {id:'trigger',type:'trigger',data:{attributes:{keywords:['hi','services','quote']}}},
    ...[[welcome,'WELCOME MESSAGE'],[services,'Services'],[quote,'Get a Quote']].map(([id,title])=>
      ({id,type:'action',data:{key:'@whatsapp/send-button-message',title}})),
  ],edges:[{source:'trigger',sourceHandle:'default',target:welcome},
    {source:welcome,sourceHandle:welcomeServices,target:services},
    {source:services,sourceHandle:getQuote,target:quote},
    {source:quote,sourceHandle:quoteServices,target:services}]};
  const original=JSON.stringify(bot);
  const session={id:'session',chatbot_id:bot.id,current_node_id:welcome,variables:{event:'wedding'}};
  const sent=[],lookups=[];
  let restarts=0;
  const sessions={findActiveByPhoneNumberId:async()=>session,findActiveSession:async()=>session,
    update:async(_id,data)=>Object.assign(session,data),
    deactivateOtherBots:async()=>{throw Error('Connected choice must not deactivate bots')},
    deactivateActiveSession:async()=>{throw Error('Connected choice must not reset the session')}};
  const menu=load('src/app/services/chatbot/flows/menu.flow.ts',{
    '@surefy/console/app/models/chatSession.model':sessions,
    '@surefy/console/services/chatbot/engine/executeNode':{executeNode:async({currentNode})=>({text:currentNode.data.title})},
  });
  const router=load('src/app/services/chatbot/flow.route.ts',{
    '../../models/chatSession.model':sessions,'./flows/menu.flow':menu,
    './flows/trigger.flow':{triggerFlow:async()=>{restarts++;return {text:'WELCOME MESSAGE'}}},
  });
  const api=load('src/app/services/chatbot/chatbot.service.ts',{
    './runtimeBot':{getRuntimeBot:async(_phone,id,text)=>{lookups.push({id,text});return bot}},
    '@surefy/console/app/models/chatSession.model':sessions,
    './flow.route':router,
    '@surefy/console/services/message.service':{sendChatBotMessage:async(_sender,_phone,response)=>sent.push(response.text)},
    '@surefy/console/models/contact.model':{findOrCreateIncoming:async()=>{}},
    '../../models/phoneNumber.model':{findByPhoneNumberId:async()=>({id:'sender',user_id:'owner',company_id:'company'})},
    nodemailer:{createTransport:()=>({})},
  });
  for (const [id,title,expected] of [[welcomeServices,'Services',services],[getQuote,'Get a Quote',quote],
    [quoteServices,'Services',services]]) {
    await api.handleIncomingMessageChatBot('1262112183641961',{
      from:'919876543210',type:'interactive',interactive:{button_reply:{id,title}},
    },'Customer');
    assert.equal(session.current_node_id,expected);
  }
  assert.deepEqual(sent,['Services','Get a Quote','Services']);
  assert.equal(restarts,0);
  assert.ok(lookups.every(lookup=>lookup.id===bot.id && lookup.text===undefined));
  assert.equal(session.variables.event,'wedding');
  assert.equal(JSON.stringify(bot),original);
});
test('button payload alone does not select a keyword or default flow', async () => {
  const h=handler({keyword:{id:'support'}});
  await h.run({button:{payload:'support'}});
  assert.equal(h.routed.length,0);
  assert.equal(h.lookups.length,0);
});

test('attached Freelancer graph routes every latest-menu choice and earlier-menu navigation without restarting', async () => {
  const graph=require('./fixtures/doveknot-freelancer-routing.json');
  // Runtime rows store handles in data, not in a sourceHandle database column.
  const bot={...structuredClone(graph),id:'freelancer',user_id:'owner'};
  bot.edges=bot.edges.map(({sourceHandle,...edge})=>edge);
  const byTitle=title=>bot.nodes.find(node=>node.data.title.trim()===title);
  const main=byTitle('Main Menu');
  const session={id:'session',chatbot_id:bot.id,current_node_id:main.id,variables:{customer:'kept'}};
  const sessions={findActiveByPhoneNumberId:async()=>session,
    findActiveSession:async()=>{throw Error('Routing must reuse the selected session, not read another active row')},
    update:async(id,fields)=>{assert.equal(id,session.id);Object.assign(session,fields)},
    deactivateOtherBots:async()=>{throw Error('A connected selection must not switch chatbots')},
    deactivateActiveSession:async()=>{throw Error('A connected selection must not restart the menu')}};
  const sent=[],lookups=[];
  const menu=load('src/app/services/chatbot/flows/menu.flow.ts',{
    '@surefy/console/app/models/chatSession.model':sessions,
    '@surefy/console/services/chatbot/engine/executeNode':{executeNode:async({currentNode})=>({text:currentNode.data.title.trim()})},
  });
  const router=load('src/app/services/chatbot/flow.route.ts',{
    '../../models/chatSession.model':sessions,'./flows/menu.flow':menu,
    './flows/trigger.flow':{triggerFlow:async()=>{throw Error('Keyword collision must not restart the trigger')}},
  });
  const api=load('src/app/services/chatbot/chatbot.service.ts',{
    './runtimeBot':{getRuntimeBot:async(_phone,id,text)=>{lookups.push({id,text});return bot}},
    '@surefy/console/app/models/chatSession.model':sessions,'./flow.route':router,
    '@surefy/console/services/message.service':{sendChatBotMessage:async(_sender,_phone,response)=>sent.push(response.text)},
    '@surefy/console/models/contact.model':{findOrCreateIncoming:async()=>{}},
    '../../models/phoneNumber.model':{findByPhoneNumberId:async()=>({id:'sender',user_id:'owner',company_id:'company'})},
    nodemailer:{createTransport:()=>({})},
  });
  const click=async(source,title)=>{
    const reply=source.data.attributes.message.interactive.action.buttons.find(button=>button.reply.title.trim()===title).reply;
    await api.handleIncomingMessageChatBot('983205234883054',{
      from:'customer',type:'interactive',interactive:{button_reply:reply},
    },'Customer');
    assert.equal(sent.at(-1),title);
    assert.equal(session.current_node_id,byTitle(title).id);
  };
  // Services is tested first on the latest menu, independently of Freelancer Form.
  for(const title of ['Services','Freelancer Form','Social Media']){
    session.current_node_id=main.id;
    await click(main,title);
  }
  // Follow every declared connection in the actual attachment, including loops.
  for(const source of bot.nodes.filter(node=>node.data.attributes.message.interactive.action)){
    for(const button of source.data.attributes.message.interactive.action.buttons){
      session.current_node_id=source.id;
      await click(source,button.reply.title.trim());
    }
  }
  session.current_node_id=main.id;
  await click(main,'Freelancer Form');
  await click(main,'Services');
  await click(byTitle('Services'),'Social Media');
  await click(byTitle('Social Media'),'Main Menu');
  await api.handleIncomingMessageChatBot('983205234883054',{from:'customer',text:{body:'  SERVICES  '}},'Customer');
  assert.equal(sent.at(-1),'Services');
  assert.equal(session.current_node_id,byTitle('Services').id);
  assert.equal(session.variables.customer,'kept');
  assert.ok(lookups.every(lookup=>lookup.id===bot.id && lookup.text===undefined));
});

test('unknown, deleted and ambiguous older-menu IDs cannot select an arbitrary graph branch',()=>{
  const {resolveInteractiveEdge}=require('../src/app/services/chatbot/interactiveChoice');
  const choice=id=>({id,data:{attributes:{message:{interactive:{action:{buttons:[{reply:{id:'reused',title:'Services'}}]}}}}}});
  const bot={nodes:[{id:'current'},choice('menu-a'),choice('menu-b'),{id:'services'},{id:'other'}],edges:[
    {source:'menu-a',target:'services',sourceHandle:'reused'},
    {source:'menu-b',target:'other',sourceHandle:'reused'},
    {source:'menu-a',target:'deleted',sourceHandle:'missing'},
  ]};
  for(const id of ['reused','missing','unknown'])assert.equal(resolveInteractiveEdge(bot,'current',id,'Services'),undefined);
  assert.equal(resolveInteractiveEdge(bot,'deleted','reused'),undefined);
  assert.equal(resolveInteractiveEdge(bot,'menu-a','reused').target,'services');
});

test('typed option titles follow button and list edges without edge labels', async () => {
  const executed=[];
  const api=load('src/app/services/chatbot/flows/menu.flow.ts',{
    '@surefy/console/app/models/chatSession.model':{update:async()=>{}},
    '@surefy/console/services/chatbot/engine/executeNode':{executeNode:async args=>{executed.push(args);return {text:'response'}}}
  });
  for (const action of [
    {buttons:[{reply:{id:'choice',title:'Contact Support'}}]},
    {sections:[{rows:[{id:'choice',title:'Contact Support'}]}]},
  ]) {
    const bot={nodes:[{id:'menu',data:{attributes:{message:{interactive:{action}}}}},{id:'next'}],
      edges:[{source:'menu',target:'next',sourceHandle:'choice'}]};
    const session={id:'session',current_node_id:'menu'};
    await api.menuFlow({bot,session,incomingText:' CONTACT   support '});
    assert.equal(executed.at(-1).currentNode.id,'next');
    assert.equal((await api.menuFlow({bot,session,incomingText:''})).ignoreMessage,true);
  }
  assert.equal(executed.length,2);
});

test('matching a keyword restarts the same chatbot before continuing its session', async () => {
  let reset, started=false;
  const api=load('src/app/services/chatbot/flow.route.ts',{
    '../../models/chatSession.model':{deactivateActiveSession:async args=>{reset=args},findActiveSession:async()=>{throw Error('Should restart first')}},
    './flows/trigger.flow':{triggerFlow:async()=>{started=true;return {text:'welcome'}}}
  });
  await api.flowRouter({bot:{id:'bot'},phone:'sender',phoneNumberId:'meta',incomingText:'hello',triggerMatched:true});
  assert.equal(reset.chatbotId,'bot');
  assert.equal(reset.phoneNumberId,'meta');
  assert.equal(started,true);
});
