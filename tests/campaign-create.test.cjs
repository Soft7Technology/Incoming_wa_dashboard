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
