require('ts-node/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
class HttpError extends Error { constructor({message,details}) { super(message); this.details=details; } }
function fixture({contacts=[], saved=contacts, excluded=[], wrongSender=false, tag=null}={}) {
  const writes=[], predicates=[];
  const phone={id:'sender-db',phone_number_id:'payload-sender',user_id:wrongSender?'other':'u',company_id:'c'};
  const query={where(key,value){predicates.push([key,value]);return query;},whereRaw(){return query;},then(resolve,reject){return Promise.resolve(saved).then(resolve,reject);}};
  const deps={
    './contactOptOut.service':{excluded:async()=>new Set(excluded)},
    '../utils/campaignPhone':require('../src/app/utils/campaignPhone'),
    '../utils/campaignRecipients':require('../src/app/utils/campaignRecipients'),
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

test('invalid parameter mappings reject before contact writes', async()=>{
 for (const mapping of [[], 'bad', {'1':null}, {'1':{field:'name',value:'literal'}}, {'1':{field:123}}]) {
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
