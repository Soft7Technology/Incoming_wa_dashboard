require('ts-node/register');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const ts=require('typescript'), fs=require('fs'), vm=require('vm');
function load(file,deps={}) {
 const exports={};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,
 {exports,require:id=>deps[id]||{},console:{warn(){},log(){},error(){}},Date});
 return exports;
}
function provider(assistant={}) {
 const requests=[],lookups=[];
 const instance=load('src/app/services/aiAssistant.service.ts',{
 '../models/aiAssistant.model':{findActiveOwned:async(id,owner)=>{lookups.push([id,owner]);return assistant;}},
 '../models/message.model':{getRecentMessages:async(...args)=>{lookups.push(args);return [{direction:'inbound',content:{text:{body:'New Question'}}},{direction:'outbound',content:{text:{body:'Previous answer'}}}];}},
 '../utils/crypto.util':{decryptApiKey:key=>key==='encrypted'?'decrypted-key':null},
 axios:{post:async(...args)=>{requests.push(args);return {data:{choices:[{message:{content:'Generated reply'}}],candidates:[{content:{parts:[{text:'Gemini reply'}]}}]}}}},
 }).default;
 return {instance,requests,lookups};
}
const assistant={api_key:'encrypted',provider:'OpenAI',model:'gpt-4.1 mini',prompt_type:'custom',custom_prompt:'Answer as our support agent'};
test('selected assistant key, prompt and exact model are used with scoped chronological history once',async()=>{
 const h=provider(assistant);
 assert.equal(await h.instance.runAssistant('chosen','owner','company','number','6581234567'),'Generated reply');
 assert.deepEqual(h.lookups,[['chosen','owner'],['owner','company','number','6581234567',10]]);
 const [,payload,options]=h.requests[0];
 assert.equal(payload.model,'gpt-4.1-mini');assert.equal(payload.messages.length,3);
 assert.equal(payload.messages[0].content,assistant.custom_prompt);
 assert.equal(payload.messages[1].content,'Previous answer');assert.equal(payload.messages[2].content,'New Question');
 assert.equal(options.headers.Authorization,'Bearer decrypted-key');assert.equal(options.timeout,30000);
});
test('unavailable assistant or missing key never calls provider',async()=>{
 for(const configuration of [null,{...assistant,api_key:null}]) {
  const h=provider(configuration);await assert.rejects(h.instance.runAssistant('foreign','owner','company','number','6581234567'));
  assert.equal(h.requests.length,0);
 }
});
test('Gemini uses configured model, predefined prompt and assistant key',async()=>{
 const h=provider({...assistant,provider:'Gemini',model:'gemini-2.5-flash',prompt_type:'predefined',predefined_prompt:'Support'});
 assert.equal(await h.instance.runAssistant('chosen','owner','company','number','6581234567'),'Gemini reply');
 const [url,payload,options]=h.requests[0];assert.ok(url.includes('gemini-2.5-flash'));
 assert.equal(payload.systemInstruction.parts[0].text,'Support');assert.equal(options.headers['x-goog-api-key'],'decrypted-key');
});
test('history text handles JSON, interactive replies and unsupported media',()=>{
 const {assistantMessageText:extract}=load('src/app/services/aiAssistant.service.ts');
 assert.equal(extract({content:JSON.stringify({text:{body:'Hello'}})}),'Hello');
 assert.equal(extract({content:{interactive:{button_reply:{title:'Support'}}}}),'Support');
 assert.equal(extract({type:'image',content:{}}),'[image message]');
});
function nodeHarness(fail=false) {
 const calls=[],updates=[];
 const {runAiAgentNode}=load('src/app/services/chatbot/aiAgentNode.ts',{
 '../aiAssistant.service':{runAssistant:async(...args)=>{calls.push(args);if(fail)throw Error('secret');return 'answer';}},
 '../../models/phoneNumber.model':{findByPhoneNumberId:async()=>({id:'number',user_id:'owner',company_id:'company'})},
 '../../models/chatSession.model':{update:async(id,data)=>updates.push(data)},
 });
 const bot={user_id:'owner',company_id:'company'},session={id:'session',phoneNumberId:'meta',phone_number:'6581234567',variables:{},last_message:'Hi'};
 const node={id:'ai',data:{key:'@whatsapp/ai-agent',dataOut:{variable:'answer'},attributes:{assistantId:'chosen',stopKeywords:['/stop'],timeout:{value:5,unit:'minutes'},welcomeMessage:'Welcome',timeoutMessage:'Timed out'}}};
 return {runAiAgentNode,calls,updates,bot,session,node};
}
test('node stays active for follow-up replies, saves output and welcomes only once',async()=>{
 const h=nodeHarness();let result=await h.runAiAgentNode(h.bot,h.session,h.node);
 assert.equal(result.messages.length,2);assert.equal(h.updates[0].current_node_id,'ai');assert.equal(h.updates[0].variables.answer,'answer');
 h.session.variables=h.updates[0].variables;result=await h.runAiAgentNode(h.bot,h.session,h.node);
 assert.equal(result.messages.length,1);assert.equal(h.calls.length,2);
});
test('whole-message stop and expired inactivity exit without a provider request',async()=>{
 for(const expired of [false,true]) {
  const h=nodeHarness();h.session.last_message=expired?'Hello':' /STOP ';
  h.session.variables.chatbot_ai={nodeId:'ai',lastActivity:Date.now()-600000};
  const result=await h.runAiAgentNode(h.bot,h.session,h.node);
  assert.equal(result.exitAi,true);assert.equal(h.calls.length,0);assert.equal(h.updates[0].variables.chatbot_ai,undefined);
 }
});
test('cross-company nodes reject before provider calls and provider failures return safe text',async()=>{
 const h=nodeHarness();await assert.rejects(h.runAiAgentNode({...h.bot,company_id:'other'},h.session,h.node));assert.equal(h.calls.length,0);
 const failed=nodeHarness(true);const response=await failed.runAiAgentNode(failed.bot,failed.session,failed.node);
 assert.ok(!JSON.stringify(response).includes('secret'));assert.ok(response.messages.at(-1).text.includes('try again'));
});
test('history SQL includes company, account, number, full recipient and ten-row limit',async()=>{
 const knex=require('knex')({client:'pg'});let sql;
 class BaseModel{query(){const q=knex('messages');q.then=resolve=>{sql=q.toSQL();return Promise.resolve(resolve([]));};return q;}}
 const model=load('src/app/models/message.model.ts',{'@surefy/models/base.model':{BaseModel},'../utils/importPhone':require('../src/app/utils/importPhone')}).default;
 await model.getRecentMessages('owner','company','number','+6581234567',10);
 for(const column of ['user_id','company_id','phone_number_id'])assert.ok(sql.sql.includes('"'+column+'" = ?'));
 assert.ok(sql.bindings.includes('6581234567'));assert.equal(sql.bindings.at(-1),10);assert.ok(sql.sql.includes('"created_at" desc, "id" desc'));
 await knex.destroy();
});
test('flow engine holds AI node, then follows its next edge on exit',async()=>{
 let exit=false;const updates=[];
 const {executeNode}=load('src/app/services/chatbot/engine/executeNode.ts',{
 '../aiAgentNode':{runAiAgentNode:async()=>exit?{exitAi:true,messages:[]}:{messages:[{type:'text',text:'AI answer'}]}},
 '@surefy/console/app/models/chatSession.model':{update:async(id,data)=>updates.push(data)},
 '@surefy/console/utils':{buildResponse:async()=>({type:'text',text:'Next step'})},
 });
 const node={id:'ai',data:{key:'@whatsapp/ai-agent'}},next={id:'next',data:{key:'@whatsapp/ask-question'}};
 const bot={nodes:[node,next],edges:[{source:'ai',target:'next'}]},session={id:'session'};
 assert.equal((await executeNode({bot,session,currentNode:node})).messages[0].text,'AI answer');assert.equal(updates.length,0);
 exit=true;assert.equal((await executeNode({bot,session,currentNode:node})).messages[0].text,'Next step');assert.equal(updates[0].current_node_id,'next');
});
test('menu flow routes ongoing text back to AI without requiring an edge match',async()=>{
 let executed;
 const {menuFlow}=load('src/app/services/chatbot/flows/menu.flow.ts',{
 '@surefy/console/services/chatbot/engine/executeNode':{executeNode:async args=>{executed=args;return {text:'answer'}}},
 });
 const node={id:'ai',data:{key:'@whatsapp/ai-agent'}};
 await menuFlow({bot:{nodes:[node],edges:[]},session:{id:'session',current_node_id:'ai',variables:{}},incomingText:'mixed case',message:{text:{body:'Mixed CASE'}}});
 assert.equal(executed.currentNode.id,'ai');assert.equal(executed.session.last_message,'Mixed CASE');
});
