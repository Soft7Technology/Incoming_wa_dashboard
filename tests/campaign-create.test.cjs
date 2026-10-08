require('ts-node/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
class HttpError extends Error { constructor({message,details}) { super(message); this.details=details; } }
const customFields = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/utils/contactCustomFields.ts','utf8'),{
 compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true},
}).outputText,{exports:customFields,require:()=>HttpError});
function fixture({contacts=[], saved=contacts, excluded=[], wrongSender=false, tag=null}={}) {
  const writes=[], predicates=[];
  const phone={id:'sender-db',phone_number_id:'payload-sender',user_id:wrongSender?'other':'u',company_id:'c'};
  const query={where(key,value){predicates.push([key,value]);return query;},whereRaw(){return query;},then(resolve,reject){return Promise.resolve(saved).then(resolve,reject);}};
  const deps={
    './contactOptOut.service':{excluded:async()=>new Set(excluded)},
    '../utils/campaignPhone':require('../src/app/utils/campaignPhone'),
    '../utils/campaignRecipients':require('../src/app/utils/campaignRecipients'),
    '../utils/contactCustomFields':customFields,
    './planUsage.service':{run:async(_user,_feature,fn)=>{writes.push('usage');return fn({});}},
    '../models/campaign.model':{create:async data=>{writes.push({campaign:data});return {id:'campaign',...data};}},
    '../models/campaignMessage.model':{bulkCreate:async data=>{writes.push({messages:data});}},
    './contact.service':{getContactsByFilters:async()=>contacts},
    '../models/template.model':{findById:async()=>({status:'APPROVED',components:[]})},
    '../models/contact.model':{findCampaignPhoneCandidates:async()=>saved,findWithFilters:()=>query,bulkCreate:async()=>writes.push('contacts')},
    '../models/contactTag.model':{findByName:async()=>tag},
    '../models/phoneNumber.model':{findByPhoneNumberId:async()=>phone},
    '../../queues/campaignExecution.queue':{campaignExecutionQueue:{add:async()=>writes.push('queue')}},
  };
  const exports={};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/services/campaign.service.ts','utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true},
  }).outputText,{exports,Date,console:{log(){},warn(){}},require:name=>deps[name]||(name.includes('Error')?HttpError:{})});
  return {service:exports.default,writes,predicates};
}
const payload={name:'Test',phone_number_id:'payload-sender',template_id:'template'};

test('contact-prefixed custom fields and legacy attributes resolve independently into worker parameters', async()=>{
 const checks=['Hello','Welcome'];
 const contacts=checks.map((check,index)=>({
  id:`contact-${index}`,phone_number:`+91937259745${index}`,phone_number_id:'sender-db',
  custom_fields:index === 0 ? {check} : {},attributes:index === 1 ? {check} : {},
 }));
 const f=fixture({contacts});
 await f.service.createCampaign('u','c',{...payload,parameter_mapping:{
  '1':{field:'contact.custom_fields.check'},'2':{field:'contact.custom_fields.check'},
 }});
 const messages=f.writes.find(w=>w.messages).messages;
 const exports={};
 const deps={
  'bullmq':{Worker:class {on(){}}},
  '../campaignCapacity':{campaignCapacity:{},createCapacitySampler:()=>({})},
 };
 const js=ts.transpileModule(fs.readFileSync('src/queues/processors/campaignExecution.processor.ts','utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true},
 }).outputText;
 vm.runInNewContext(js+'\nexports.buildTemplatePayloadForTest = buildTemplatePayload;',{
  exports,require:name=>deps[name]||{},console:{log(){}},setInterval:()=>({unref(){}}),
 });
 for (const [index,message] of messages.entries()) {
  assert.equal(message.contact_id,contacts[index].id);
  const result=exports.buildTemplatePayloadForTest({name:'ordersw',language:'en_US',components:[
   {type:'HEADER',format:'IMAGE'},
   {type:'BODY',text:'Hiii {{1}} HOw are you doing {{2}}\nLooking forward'},
  ]},message.template_variables,[{type:'image',link:'https://example.com/image.jpg'}]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.components)),[
   {type:'header',parameters:[{type:'image',image:{link:'https://example.com/image.jpg'}}]},
   {type:'body',parameters:[{type:'text',text:checks[index]},
    {type:'text',text:checks[index]}]},
  ]);
 }
});

test('nested contact fields retain exact dotted keys, fallback rules and own-property lookup',()=>{
 const contact={name:'Parth',source:'manual',custom_fields:{
  check:'Hello','Company name':'Soft7','order.total':42,order:{total:99,paid:false},
 },attributes:{address:{city:'Pune'},count:0}};
 const f=fixture();
 const variables=f.service.resolveTemplateVariables(contact,{
  '1':{field:'contact.custom_fields.Company name'},'2':{field:'contact.custom_fields.order.total'},
  '3':{field:'custom_fields.order.total'},'4':{field:'contact.custom_fields.order.paid'},
  '5':{field:'contact.attributes.address.city'},'6':{field:'contact.attributes.count'},
  '7':{field:'contact.custom_fields.unknown',fallbackValue:'Guest'},
  '8':'contact.custom_fields.check','9':{field:'contact.source'},
  '10':{field:'contact.custom_fields.toString',fallbackValue:'safe'},
  '11':{field:'attributes.address.city'},'12':{field:'custom_fields.order.paid'},
 });
 assert.deepEqual(JSON.parse(JSON.stringify(variables)),{
  '1':'Soft7','2':'42','3':'42','4':'false','5':'Pune','6':'0','7':'Guest',
  '8':'Hello','9':'manual','10':'safe','11':'Pune','12':'false',
 });
});

test('JSON-encoded contact fields resolve per recipient using attributes when the custom field is absent',async()=>{
 const contacts=[{check:'Hello',amount:0,active:false,'order.total':42},
  JSON.stringify({check:'Welcome',amount:12,active:true,'order.total':99}),{}].map((custom_fields,index)=>({
  id:`contact-${index}`,phone_number:`+91937259745${index}`,phone_number_id:'sender-db',custom_fields,
  attributes:JSON.stringify({check:'legacy',address:{city:`City ${index}`}}),
 }));
 const f=fixture({contacts});
 await f.service.createCampaign('u','c',{...payload,parameter_mapping:{
  '1':{field:'contact.custom_fields.check',fallbackValue:'Guest'},
  '2':{field:'custom_fields.amount'},'3':{field:'contact.custom_fields.active'},
  '4':{field:'custom_fields.order.total'},'5':{field:'contact.attributes.address.city'},
  '6':{field:'attributes.address.city'},'7':'check',
 }});
 const variables=f.writes.find(w=>w.messages).messages.map(message=>message.template_variables);
 assert.deepEqual(JSON.parse(JSON.stringify(variables)),[
  {'1':'Hello','2':'0','3':'false','4':'42','5':'City 0','6':'City 0','7':'Hello'},
  {'1':'Welcome','2':'12','3':'true','4':'99','5':'City 1','6':'City 1','7':'Welcome'},
  {'1':'legacy','2':null,'3':null,'4':null,'5':'City 2','6':'City 2','7':'legacy'},
 ]);
 assert.equal(typeof contacts[1].custom_fields,'string','resolution must not mutate stored contacts');
});

test('recipient preview exposes each contact custom field object for dynamic mapping',async()=>{
 const contacts=[{check:'Hello'},JSON.stringify({check:'Welcome'})].map((custom_fields,index)=>({
  id:`contact-${index}`,phone_number:`+91937259745${index}`,phone_number_id:'sender-db',custom_fields,
  attributes:JSON.stringify({city:`City ${index}`}),
 }));
 const f=fixture({contacts});
 const result=await f.service.previewRecipients('u','c',payload);
 assert.deepEqual(JSON.parse(JSON.stringify(result.contacts.map(contact=>contact.custom_fields))),[
  {check:'Hello'},{check:'Welcome'},
 ]);
 assert.deepEqual(JSON.parse(JSON.stringify(result.contacts.map(contact=>contact.attributes))),[
  {city:'City 0'},{city:'City 1'},
 ]);
 assert.equal(f.writes.length,0);
});

test('custom fields and attributes use recipient-specific fallback with predictable precedence',async()=>{
 const contacts=[
  {custom_fields:{check:'Custom',zero:0,flag:false,empty:'',nullable:null,nested:{value:'custom nested'},'order.total':42},
   attributes:{check:'Attribute',zero:99,flag:true,empty:'replacement',nullable:'From attributes',nested:{value:'attribute nested'},'order.total':99}},
  {custom_fields:{},attributes:{check:'Second contact',nested:{value:'second nested'},'order.total':12}},
  {custom_fields:null,attributes:null},
 ].map((fields,index)=>({id:`contact-${index}`,phone_number:`+91937259745${index}`,phone_number_id:'sender-db',...fields}));
 const f=fixture({contacts});
 await f.service.createCampaign('u','c',{...payload,parameter_mapping:{
  '1':{field:'contact.custom_fields.check',fallbackValue:'Guest'},
  '2':{field:'attributes.check'},'3':{field:'contact.attributes.check'},
  '4':{field:'custom_fields.zero'},'5':{field:'custom_fields.flag'},'6':{field:'custom_fields.empty'},
  '7':{field:'custom_fields.nullable'},'8':{field:'contact.custom_fields.nested.value'},
  '9':{field:'custom_fields.order.total'},'10':{field:'attributes.missing',fallbackValue:'Default'},
  '11':'nullable',
 }});
 assert.deepEqual(JSON.parse(JSON.stringify(f.writes.find(w=>w.messages).messages.map(m=>m.template_variables))),[
  {'1':'Custom','2':'Attribute','3':'Attribute','4':'0','5':'false','6':'','7':'From attributes',
   '8':'custom nested','9':'42','10':'Default','11':'From attributes'},
  {'1':'Second contact','2':'Second contact','3':'Second contact','4':null,'5':null,'6':null,'7':null,
   '8':'second nested','9':'12','10':'Default','11':'nullable'},
  {'1':'Guest','2':null,'3':null,'4':null,'5':null,'6':null,'7':null,'8':null,'9':null,'10':'Default','11':'nullable'},
 ]);
 const reverse=f.service.resolveTemplateVariables({custom_fields:{check:'Custom'},attributes:{}},{
  '1':{field:'attributes.check'},'2':{field:'contact.attributes.check'},
 });
 assert.deepEqual(JSON.parse(JSON.stringify(reverse)),{'1':'Custom','2':'Custom'});
});

test('malformed referenced custom fields report the contact before campaign writes',async()=>{
 for(const custom_fields of ['{broken','[]']) {
  const f=fixture({contacts:[{id:'bad-contact',phone_number:'+919372597458',phone_number_id:'sender-db',custom_fields}]});
  await assert.rejects(f.service.createCampaign('u','c',{...payload,send_immediately:true,
   parameter_mapping:{'1':{field:'contact.custom_fields.check'}}}),/Contact bad-contact custom_fields must/);
  assert.equal(f.writes.length,0);
 }
 const f=fixture({contacts:[{id:'contact',name:'Alice',phone_number:'+919372597458',
  phone_number_id:'sender-db',attributes:'{unused'}]});
 await f.service.createCampaign('u','c',{...payload,parameter_mapping:{'1':{field:'contact.name'}}});
 assert.equal(f.writes.find(w=>w.messages).messages[0].template_variables['1'],'Alice');
});

test('campaign mappings resolve dynamic columns, custom fields, literals and missing-value fallbacks', async()=>{
 const contact={id:'contact',name:'NK',phone_number:'+919372597458',phone_number_id:'sender-db',source:'import',
  custom_fields:{tier:'gold',balance:0,active:false,'Company name':'Soft7'},attributes:{city:'Pune'}};
 const f=fixture({contacts:[contact]});
 await f.service.createCampaign('u','c',{...payload,parameter_mapping:{
  '1':'fullName','2':'source','3':'tier','4':{field:'custom_fields.balance',fallbackValue:'missing'},
  '5':{field:'custom_fields.active'},'6':{field:'custom_fields.unknown',fallbackValue:'Guest'},
  '7':{value:'name'},'8':'2','9':{field:'attributes.city'},'10':'vb_phoneno',
  '11':{field:'custom_fields.Company name'},'12':{fallbackValue:'Default'},
 }});
 assert.deepEqual(JSON.parse(JSON.stringify(f.writes.find(w=>w.messages).messages[0].template_variables)),{
  '1':'NK','2':'import','3':'gold','4':'0','5':'false','6':'Guest','7':'name','8':'2',
  '9':'Pune','10':'+919372597458','11':'Soft7','12':'Default',
 });
});

test('campaign name mapping preserves existing values and falls back for null or missing names', async()=>{
 const contacts=['Alice',null,undefined,''].map((name,index)=>({
  id:`contact-${index}`,phone_number:`+91937259745${index}`,phone_number_id:'sender-db',
  ...(name === undefined ? {} : {name}),
 }));
 const f=fixture({contacts});
 await f.service.createCampaign('u','c',{...payload,parameter_mapping:{
  '1':{field:'contact.name',fallbackValue:'Guest'},
 }});
 assert.deepEqual(Array.from(f.writes.find(w=>w.messages).messages,message=>message.template_variables['1']),
  ['Alice','Guest','Guest','']);
});

test('campaigns without fallbacks save null for missing values and still queue immediately', async()=>{
 const contacts=['Alice',null,undefined,'',0,false].map((name,index)=>({
  id:`contact-${index}`,phone_number:`+91937259745${index}`,phone_number_id:'sender-db',
  ...(name === undefined ? {} : {name}),custom_fields:{company:null},
 }));
 const f=fixture({contacts});
 const campaign=await f.service.createCampaign('u','c',{...payload,send_immediately:true,parameter_mapping:{
  '1':{field:'contact.name'},'2':{field:'contact.name',fallbackValue:null},
  '3':'fullName','4':{field:'custom_fields.company'},'5':{field:'attributes.missing'},
  '6':{field:'contact.name',fallbackValue:''},
 }});
 const messages=JSON.parse(JSON.stringify(f.writes.find(w=>w.messages).messages));
 assert.equal(campaign.total_recipients,6);
 assert.equal(campaign.status,'scheduled');
 assert.equal(f.writes.at(-1),'queue');
 for (const key of ['1','2','3']) {
  assert.deepEqual(messages.map(message=>message.template_variables[key]),['Alice',null,null,'','0','false']);
 }
 for (const message of messages) {
  assert.equal(message.template_variables['4'],null);
  assert.equal(message.template_variables['5'],null);
 }
 assert.deepEqual(messages.map(message=>message.template_variables['6']),['Alice','','','','0','false']);
});

test('campaign test payload preserves resolved null template parameters',()=>{
 const f=fixture();
 const variables=f.service.resolveTemplateVariables({name:null},{
  '1':{field:'contact.name'},'2':{field:'custom_fields.missing',fallbackValue:'Guest'},'3':{value:''},
 });
 const result=f.service.buildTemplatePayload({name:'test',language:'en',components:[{type:'BODY',text:'Hi {{1}} {{2}} {{3}}'}]},variables);
 assert.deepEqual(JSON.parse(JSON.stringify(result.components[0].parameters)),[
  {type:'text',text:null},{type:'text',text:'Guest'},{type:'text',text:''},
 ]);
});

test('invalid parameter mappings reject before contact writes', async()=>{
 for (const mapping of [[], 'bad', {'1':null}, {'1':{field:'name',value:'literal'}}, {'1':{field:123}},
  {'1':{field:'name',fallbackValue:123}}, {'1':{field:null}}, {'1':{value:null}}]) {
  const f=fixture();
  await assert.rejects(f.service.createCampaign('u','c',{...payload,parameter_mapping:mapping}),/parameter_mapping/);
  assert.equal(f.writes.length,0);
 }
});

test('recipient preview counts unique list matches for the sender, excluding opt-outs, without writes', async()=>{
 const contacts=[
  {id:'first',name:'First',phone_number:'+919372597458',phone_number_id:'sender-db'},
  {id:'duplicate',phone_number:'+919372597458',phone_number_id:'sender-db'},
  {id:'blocked',phone_number:'+919372597459',phone_number_id:'sender-db'},
  {id:'foreign',phone_number:'+919372597460',phone_number_id:'other-sender'},
 ];
 const f=fixture({contacts,excluded:['919372597459']});
 const result=await f.service.previewRecipients('u','c',{phone_number_id:'payload-sender',contact_filters:{list_ids:['list']}});
 assert.equal(result.total_recipients,1);
 assert.equal(result.contacts[0].id,'first');
 assert.equal(result.contacts[0].recipient_number,'919372597458');
 assert.equal(f.writes.length,0);
});

test('preview returns zero matches and previews external numbers without creating contacts',async()=>{
 const empty=fixture();
 assert.equal((await empty.service.previewRecipients('u','c',payload)).total_recipients,0);
 const external=fixture();
 const result=await external.service.previewRecipients('u','c',{...payload,contact_filters:{contactNumber:['+919372597458']}});
 assert.equal(result.total_recipients,1);
 assert.equal(result.contacts[0].id,null);
 assert.equal(external.writes.length,0);
 const filtered=fixture();
 assert.equal((await filtered.service.previewRecipients('u','c',{...payload,contact_filters:{contactNumber:['+919372597458'],list_ids:['list']}})).total_recipients,0);
 assert.equal(filtered.writes.length,0);
});
test('empty filter matches reject campaign before writes or queueing',async()=>{
 const f=fixture();
 await assert.rejects(f.service.createCampaign('u','c',{...payload,send_immediately:true}),error=>{
  assert.match(error.message,/Campaign cannot be created: no contacts match/);
  assert.equal(error.details.code,'CAMPAIGN_NO_MATCHING_CONTACTS');return true;
 });
 assert.equal(f.writes.length,0);
});
test('explicit numbers reuse contacts connected to the payload sender',async()=>{
 const contact={id:'contact',phone_number:'9372597458',country_code:'91',phone_number_id:'sender-db'};
 const f=fixture({contacts:[contact]});
 const campaign=await f.service.createCampaign('u','c',{...payload,contact_filters:{contactNumber:['9372597458']}});
 assert.equal(campaign.phone_number_id,'payload-sender');
 assert.equal(campaign.total_recipients,1);
 assert.equal(f.writes.includes('contacts'),false);
 assert.equal(f.predicates.some(([key,value])=>key==='phone_number_id'&&value==='sender-db'),true);
 assert.equal(f.predicates.some(([key,value])=>key==='contacts.company_id'&&value==='c'),true);
 assert.equal(f.writes.find(w=>w.messages).messages[0].contact_id,'contact');
});
test('selected numbers not matching filters return a specific campaign error',async()=>{
 const contact={id:'contact',phone_number:'+919372597458',country_code:'91',phone_number_id:'sender-db'};
 const f=fixture({saved:[contact],contacts:[]});
 await assert.rejects(f.service.createCampaign('u','c',{...payload,contact_filters:{contactNumber:['+919372597458'],tag_ids:['tag']}}),/none of the selected contact numbers match/);
 assert.equal(f.writes.length,0);
});
test('unknown tags cannot fall back to sending to all contacts',async()=>{
 const f=fixture({contacts:[{phone_number:'+919372597458'}]});
 await assert.rejects(f.service.createCampaign('u','c',{...payload,contact_filters:{tags:['missing']}}),/selected contact tags/);
 assert.equal(f.writes.length,0);
});
test('opted-out recipients and a sender owned by another user cannot create a campaign',async()=>{
 const f=fixture({contacts:[{phone_number:'+919372597458',phone_number_id:'sender-db'}],excluded:['919372597458']});
 await assert.rejects(f.service.createCampaign('u','c',payload),/all matching contacts have opted out/);
 assert.equal(f.writes.length,0);
 const other=fixture({wrongSender:true});
 await assert.rejects(other.service.createCampaign('u','c',payload),/sending phone number is not connected/);
 assert.equal(other.writes.length,0);
});

test('contacts connected to another sender cannot create a campaign',async()=>{
 const f=fixture({contacts:[{id:'other',phone_number:'+919372597458',phone_number_id:'other-sender'}]});
 await assert.rejects(f.service.createCampaign('u','c',payload),/no contacts match.*selected sending phone number/);
 assert.equal(f.writes.length,0);
});
