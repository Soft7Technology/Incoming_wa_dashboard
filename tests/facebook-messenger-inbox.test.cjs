const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');
const express=require('express');
const knex=require('knex');
class AppError extends Error { constructor(message,status){super(message);this.statusCode=status;} }
function load(file,deps,globals={}){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText,{...globals,exports,require(id){if(id in deps)return deps[id];if(id==='@surefy/exceptions/CustomError')return {CustomError:AppError};if(id==='@surefy/utils/Controller')return {tryCatchAsync:fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next)};throw new Error('Unexpected dependency '+id);}});return exports.default;}
const scope={companyId:'company-a',ownerId:'owner-a',userId:'owner-a'};
const uuid='c36be49c-c400-4524-a7ec-7841c78e7a28';
class SendError extends AppError { constructor(message,status,uncertain){super(message,status);this.uncertain=uncertain;} }
function serviceFor(model, messages={}, graph={}){return load('src/app/services/facebookMessaging.service.ts',{'../models/facebookConversation.model':model,'../models/facebookMessage.model':messages,'./facebookMessengerGraph.service':{__esModule:true,default:graph,MessengerSendError:SendError}});}

test('inbox reads reject non-owners and foreign/missing resources before listing data',async()=>{
 let calls=0;
 const service=serviceFor({findPage:async()=>null,findConversation:async()=>null,list:async()=>{calls++;},listMessages:async()=>{calls++;}});
 await assert.rejects(service.listConversations(uuid,{...scope,userId:'other'}, {page:1,limit:25}),e=>e.statusCode===403);
 await assert.rejects(service.listConversations(uuid,scope,{page:1,limit:25}),e=>e.statusCode===404);
 await assert.rejects(service.listMessages(uuid,scope,{page:1,limit:50}),e=>e.statusCode===404);
 assert.equal(calls,0);
});

test('empty lists succeed; pagination trims lookahead and message history is chronological',async()=>{
 const service=serviceFor({findPage:async()=>({id:uuid}),findConversation:async()=>({id:uuid}),list:async()=>[],listMessages:async(id,actualScope,limit,offset)=>{
 assert.equal(id,uuid);assert.equal(actualScope,scope);assert.equal(limit,2);assert.equal(offset,2);return [{id:'new'},{id:'older'},{id:'extra'}];
 }});
 const empty=await service.listConversations(uuid,scope,{page:1,limit:25});assert.equal(empty.conversations.length,0);assert.equal(empty.pagination.has_more,false);
 const messages=await service.listMessages(uuid,scope,{page:2,limit:2});assert.equal(JSON.stringify(messages.messages),JSON.stringify([{id:'older'},{id:'new'}]));assert.equal(messages.pagination.has_more,true);
});

test('both list queries enforce company and owner scope and exclude token columns',async()=>{
 const db=knex({client:'pg'});
 const model=load('src/app/models/facebookConversation.model.ts',{'@surefy/database':db});
 for(const query of [model.list(uuid,scope,25,0),model.listMessages(uuid,scope,50,0)]){
 const {sql,bindings}=query.toSQL();assert.match(sql,/"page"\."company_id" = \?/);assert.match(sql,/"page"\."owner_id" = \?/);assert.ok(bindings.includes('company-a'));assert.ok(bindings.includes('owner-a'));assert.ok(bindings.includes(uuid));assert.doesNotMatch(sql,/token_ciphertext|access_token/);
 }
 await db.destroy();
});

test('GET routes validate IDs, limits and pagination and return the frontend envelope',async t=>{
 const calls=[];
 const controller=load('src/app/http/controllers/facebookMessaging.controller.ts',{
 '../../utils/facebook':{uuidPattern:/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i},
 '../../services/facebookMessaging.service':{
 listConversations:async(id,s,p)=>{calls.push({id,s,p});return {conversations:[],pagination:{...p,has_more:false}};},
 listMessages:async()=>({messages:[]})},
 });
 const app=express();app.use((req,res,next)=>{Object.assign(req,scope);next();});
 app.get('/pages/:pageConnectionId/conversations',controller.listConversations);
 app.get('/conversations/:conversationId/messages',controller.listMessages);
 app.use((err,req,res,next)=>res.status(err.statusCode||500).json({message:err.message}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`;
 const response=await fetch(`${base}/pages/${uuid}/conversations?limit=25`);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual((await response.json()).data.conversations,[]);
 assert.equal(calls[0].s.companyId,scope.companyId);assert.equal(calls[0].p.page,1);
 for(const suffix of ['limit=0','limit=101','limit=1.5','limit=abc','limit=2&limit=3','page=-1','page=9007199254740991&limit=100'])assert.equal((await fetch(`${base}/pages/${uuid}/conversations?${suffix}`)).status,400);
 assert.equal((await fetch(`${base}/pages/invalid/conversations`)).status,400);
 assert.equal((await fetch(`${base}/conversations/${uuid}/messages`)).status,200);
});

test('reply service sends once, returns a safe message, and replays without calling Meta',async()=>{
 let sends=0, completions=0;
 const message={id:uuid,conversation_id:uuid,client_request_id:uuid,text:'Hello',direction:'outbound',status:'sending',event_at:new Date(),internal:'not exposed'};
 const model={reserveReply:async()=>({message,replay:false,pageId:'123',psid:'456',ciphertext:'encrypted'}),completeReply:async(id,mid)=>{completions++;assert.equal(mid,'mid.1');return {...message,status:'sent',meta_message_id:mid};}};
 const service=serviceFor({},model,{sendText:async(...args)=>{sends++;assert.deepEqual(args,['123','456','encrypted','Hello']);return 'mid.1';}});
 const result=await service.sendMessage(uuid,scope,'Hello',uuid);
 assert.equal(result.status,'sent');assert.equal(result.internal,undefined);assert.equal(sends,1);assert.equal(completions,1);
 model.reserveReply=async()=>({message:result,replay:true});
 assert.equal((await service.sendMessage(uuid,scope,'Hello',uuid)).id,uuid);assert.equal(sends,1);
 await assert.rejects(service.sendMessage(uuid,{...scope,userId:'other'},'Hello',uuid),e=>e.statusCode===403);
});

test('reply failures preserve uncertainty and never mark accepted messages as rejected',async()=>{
 for(const uncertain of [false,true]){
 let recorded;
 const service=serviceFor({}, {reserveReply:async()=>({message:{id:uuid},replay:false}),failReply:async(...args)=>{recorded=args;}}, {sendText:async()=>{throw new SendError('Safe failure',502,uncertain);}});
 await assert.rejects(service.sendMessage(uuid,scope,'Hello',uuid),e=>e.message==='Safe failure');
 assert.deepEqual(recorded,[uuid,'Safe failure',uncertain]);
 }
 let failed=false;
 const service=serviceFor({}, {reserveReply:async()=>({message:{id:uuid},replay:false}),completeReply:async()=>{throw Error('DB down');},failReply:async()=>{failed=true;}}, {sendText:async()=> 'mid.1'});
 await assert.rejects(service.sendMessage(uuid,scope,'Hello',uuid),e=>e.statusCode===503);
 assert.equal(failed,false);
});

test('profile enrichment saves available names, is bounded, and tolerates denied access',async()=>{
 let lookups=0,saves=0;
 const model={findPage:async()=>({id:uuid}),list:async()=>Array.from({length:5},(_,i)=>({id:String(i)})),claimProfile:async(id)=>({id,psid:id,token_ciphertext:'encrypted'}),saveName:async()=>{saves++;return 1;}};
 const service=serviceFor(model,{}, {getName:async psid=>{lookups++;if(psid==='1')throw Error('permission');return 'Test Person';}});
 const result=await service.listConversations(uuid,scope,{limit:25,page:1});
 assert.equal(lookups,3);assert.equal(saves,2);assert.equal(result.conversations[0].participant_name,'Test Person');assert.equal(result.conversations[1].participant_name,undefined);
});

test('POST accepts the frontend body, validates input, and returns the saved message',async t=>{
 const calls=[];
 const controller=load('src/app/http/controllers/facebookMessaging.controller.ts',{
 '../../utils/facebook':{uuidPattern:/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i},
 '../../services/facebookMessaging.service':{sendMessage:async(...args)=>{calls.push(args);return {id:uuid,text:args[2],status:'sent'};}},
 });
 const app=express();app.use(express.json());app.use((req,res,next)=>{Object.assign(req,scope);next();});
 app.post('/conversations/:conversationId/messages',controller.sendMessage);
 app.use((err,req,res,next)=>res.status(err.statusCode||500).json({message:err.message}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}/conversations/${uuid}/messages`;
 const send=body=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const response=await send({text:' Hello ',client_request_id:uuid});assert.equal(response.status,200);assert.equal((await response.json()).data.text,'Hello');
 assert.equal(calls[0][0],uuid);assert.equal(calls[0][3],uuid);
 for(const body of [{text:'Hello'},{text:3,client_request_id:uuid},{text:' ',client_request_id:uuid},{text:'x'.repeat(2001),client_request_id:uuid},{text:'Hello',client_request_id:'invalid'}])assert.equal((await send(body)).status,400);
 assert.equal(calls.length,1);
});

test('Graph sends with the Page token and App 2 proof; errors expose no credentials',async()=>{
 const crypto=require('node:crypto');
 const axios={post:async(url,body,options)=>{
 assert.equal(url,'https://graph.facebook.com/v23.0/123/messages');
 assert.equal(JSON.stringify(body),JSON.stringify({recipient:{id:'456'},messaging_type:'RESPONSE',message:{text:'Hello'}}));
 assert.equal(options.headers.Authorization,'Bearer fixture-token');
 assert.equal(options.params.appsecret_proof,crypto.createHmac('sha256','fixture-secret').update('fixture-token').digest('hex'));
 return {data:{recipient_id:'456',message_id:'mid.1'}};
 },isAxiosError:e=>e.isAxiosError};
 // The real CustomError resets the prototype. Subclasses must restore theirs.
 class BaseError extends AppError {constructor(message,status){super(message,status);Object.setPrototypeOf(this,BaseError.prototype);}}
 const graph=load('src/app/services/facebookMessengerGraph.service.ts',{
 axios,crypto,'@surefy/exceptions/CustomError':{CustomError:BaseError},
 '../utils/facebook':{decrypt:()=> 'fixture-token',graphFailure:()=>({message:'Safe rejection',status:403})},
 },{process:{env:{FACEBOOK_MESSENGER_APP_SECRET:'fixture-secret',FACEBOOK_GRAPH_VERSION:'v23.0'}}});
 assert.equal(await graph.sendText('123','456','encrypted','Hello'),'mid.1');
 axios.post=async()=>{throw {isAxiosError:true,response:{status:400,data:{error:{code:200,message:'fixture-token'}}},config:{secret:'fixture-secret'}};};
 await assert.rejects(graph.sendText('123','456','encrypted','Hello'),e=>e.statusCode===403&&e.uncertain===false&&e.message==='Safe rejection');
 axios.post=async()=>{throw Error('Timeout with fixture-token');};
 await assert.rejects(graph.sendText('123','456','encrypted','Hello'),e=>e.uncertain===true&&!e.message.includes('fixture-token'));
 axios.post=async()=>({data:{recipient_id:'789',message_id:'mid.2'}});
 await assert.rejects(graph.sendText('123','456','encrypted','Hello'),e=>e.uncertain===true);
 axios.get=async()=>({data:{id:'456',first_name:'Test',last_name:'Person'}});
 assert.equal(await graph.getName('456','encrypted'),'Test Person');
 axios.get=async()=>({data:{id:'789',first_name:'Wrong'}});
 assert.equal(await graph.getName('456','encrypted'),null);
});

test('Messenger captures standalone shared emails, ignores invalid values, mentions and echoes',async()=>{
 const saved=[];
 const service=load('src/app/services/facebookWebhook.service.ts',{
 axios:{},crypto:require('node:crypto'),'@surefy/database':{},
 '../utils/facebook':{verifySignature:()=>true},
 '../models/facebookLeadPage.model':{},'../models/facebookLeadForm.model':{},'../models/facebookLead.model':{},
 '../models/facebookMessage.model':{saveIncoming:async input=>saved.push(input)},
 },{Buffer,process:{env:{FACEBOOK_MESSENGER_APP_SECRET:'test-secret'}}});
 const messages=[
 {text:'Share email',quick_reply:{payload:'Person@EXAMPLE.COM'}},
 {text:' person+sales@example.com '},
 {text:'Please contact someone@example.com'},
 {text:'bad..address@example.com'},
 {text:'user@-example.com'},
 {text:'Hello',quick_reply:{payload:{email:'not-a-field@example.com'}}},
 {text:'x'.repeat(65)+'@example.com'},
 {text:'page@example.com',is_echo:true},
 ];
 const body=Buffer.from(JSON.stringify({object:'page',entry:[{id:'123',messaging:messages.map((message,i)=>({sender:{id:'456',email:'ignored@example.com'},recipient:{id:'123'},timestamp:1700000000000+i,message:{mid:'mid.'+i,...message}}))}]}));
 await service.receiveMessaging(body,'test');
 assert.equal(saved.length,7);
 assert.equal(saved[0].sharedEmail.email,'Person@example.com');assert.equal(saved[0].sharedEmail.source,'quick_reply');
 assert.equal(saved[1].sharedEmail.email,'person+sales@example.com');assert.equal(saved[1].sharedEmail.source,'message_text');
 for(const row of saved.slice(2))assert.equal(row.sharedEmail,undefined);
});

test('reply reservations enforce tenant/window/retry rules and persist messages and names (rollback)', {skip:process.env.MESSENGER_DB_TEST!=='1'}, async()=>{
 require('ts-node/register/transpile-only');
 const config=require('../library/surefy/src/config/knex.config.ts').default;
 const db=knex(config[process.env.NODE_ENV||'development']);
 const {randomUUID}=require('node:crypto');
 const rollback=new Error('rollback fixture');
 try {
 await assert.rejects(db.transaction(async trx=>{
 const user=await trx('users').whereNotNull('company_id').first('id','company_id');assert.ok(user);
 const actualScope={companyId:user.company_id,ownerId:user.id,userId:user.id};
 const pageId=randomUUID(),conversationId=randomUUID(),requestId=randomUUID(),customerAt=new Date();
 await trx('facebook_pages').insert({id:pageId,company_id:user.company_id,owner_id:user.id,page_id:'test-'+randomUUID(),name:'Messenger test fixture',facebook_user_id:'123',status:'connected',token_ciphertext:'fixture'});
 await trx('facebook_conversations').insert({id:conversationId,page_connection_id:pageId,psid:'456',last_customer_message_at:customerAt});
 const model=load('src/app/models/facebookMessage.model.ts',{'@surefy/database':trx,crypto:require('node:crypto')});
 await assert.rejects(model.reserveReply(conversationId,{...actualScope,companyId:randomUUID()},'Hello',requestId),e=>e.statusCode===404);
 const reserved=await model.reserveReply(conversationId,actualScope,'Hello',requestId);assert.equal(reserved.message.status,'sending');
 await assert.rejects(model.reserveReply(conversationId,actualScope,'Hello',requestId),e=>e.statusCode===409);
 await model.failReply(reserved.message.id,'Rejected',false);
 const retry=await model.reserveReply(conversationId,actualScope,'Hello',requestId);assert.equal(retry.message.id,reserved.message.id);
 const sent=await model.completeReply(retry.message.id,'mid.fixture');assert.equal(sent.status,'sent');
 assert.equal((await model.reserveReply(conversationId,actualScope,'Hello',requestId)).replay,true);
 await assert.rejects(model.reserveReply(conversationId,actualScope,'Changed',requestId),e=>e.statusCode===409);
 const uncertainId=randomUUID();const uncertain=await model.reserveReply(conversationId,actualScope,'Another',uncertainId);
 await model.failReply(uncertain.message.id,'Uncertain',true);
 await assert.rejects(model.reserveReply(conversationId,actualScope,'Another',uncertainId),e=>e.statusCode===409);
 const current=await trx('facebook_conversations').where({id:conversationId}).first();assert.equal(new Date(current.last_customer_message_at).getTime(),customerAt.getTime());
 await trx('facebook_conversations').where({id:conversationId}).update({last_customer_message_at:new Date(Date.now()-25*3600000)});
 await assert.rejects(model.reserveReply(conversationId,actualScope,'Too late',randomUUID()),e=>e.statusCode===409);
 const conversations=load('src/app/models/facebookConversation.model.ts',{'@surefy/database':trx});
 const context=await conversations.claimProfile(conversationId,actualScope);assert.ok(context);
 assert.equal(await conversations.claimProfile(conversationId,actualScope),null);
 assert.equal(await conversations.saveName(context,{...actualScope,companyId:randomUUID()},'Wrong'),0);
 assert.equal(await conversations.saveName(context,actualScope,'Test Person'),1);
 assert.equal((await conversations.list(pageId,actualScope,25,0))[0].participant_name,'Test Person');
 const rows=await conversations.listMessages(conversationId,actualScope,50,0);assert.equal(rows.length,2);assert.ok(rows.some(row=>row.meta_message_id==='mid.fixture'&&row.direction==='outbound'));
 const fixturePage=await trx('facebook_pages').where({id:pageId}).first('page_id');
 const emailEvent={pageId:fixturePage.page_id,senderId:'456',messageId:'mid.email.new',text:'new@example.com',eventAt:new Date(),payload:{},sharedEmail:{email:'new@example.com',source:'quick_reply'}};
 await model.saveIncoming(emailEvent);
 let listed=(await conversations.list(pageId,actualScope,25,0))[0];
 assert.equal(listed.participant_email,'new@example.com');assert.equal(listed.participant_email_source,'quick_reply');
 await model.saveIncoming({...emailEvent,sharedEmail:{email:'duplicate@example.com',source:'message_text'}});
 await model.saveIncoming({...emailEvent,messageId:'mid.email.old',eventAt:new Date(emailEvent.eventAt.getTime()-1000),sharedEmail:{email:'old@example.com',source:'message_text'}});
 await model.saveIncoming({...emailEvent,messageId:'mid.email.none',eventAt:new Date(emailEvent.eventAt.getTime()+1000),text:'Hello again',sharedEmail:undefined});
 listed=(await conversations.list(pageId,actualScope,25,0))[0];assert.equal(listed.participant_email,'new@example.com');
 await model.saveIncoming({...emailEvent,messageId:'mid.email.other',senderId:'789',sharedEmail:undefined});
 assert.equal((await trx('facebook_conversations').where({page_connection_id:pageId,psid:'789'}).first()).participant_email,null);
 await model.saveIncoming({...emailEvent,messageId:'mid.email.latest',eventAt:new Date(emailEvent.eventAt.getTime()+2000),sharedEmail:{email:'latest@example.com',source:'message_text'}});
 listed=(await conversations.list(pageId,actualScope,25,0)).find(c=>c.id===conversationId);assert.equal(listed.participant_email,'latest@example.com');assert.equal(listed.participant_email_source,'message_text');
 throw rollback;
 }),e=>e===rollback);
 }finally{await db.destroy();}
});
