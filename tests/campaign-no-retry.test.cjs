const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function worker({sendError,saveError,claim=true}={}) {
 let sends=0,claimed=false;const statuses=[];
 class Worker{on(){return this;}}
 const deps={bullmq:{Worker,DelayedError:class extends Error{}},'../campaignExecution.queue':{campaignExecutionQueue:{}},
 '../campaignCapacity':{campaignCapacity:{concurrency:1},createCapacitySampler:()=>({})},
 '../campaignPacing':{waitForCampaignPermit:async()=>true},'../campaignUserSlots':{},
 '../campaignDatabaseError':{isConnectionAcquireError:()=>false},
 '../../app/utils/campaignPhone':{campaignRecipientNumber:n=>n.replace('+','')},
 '@surefy/console/app/utils/messageError':{getMessageError:e=>({error_code:String(e.code||'UNKNOWN'),error_message:e.message})},
 '@surefy/console/models/campaignMessage.model':{
 claimSingleAttempt:async()=>{if(!claim||claimed)return false;claimed=true;return true;},
 recordSent:async()=>{if(saveError)throw Error('database write failed');},
 updateStatus:async(id,status)=>statuses.push(status)},
 '@surefy/console/models/campaign.model':{incrementCount:async()=>{}},
 '@surefy/console/models/contact.model':{incrementFailedCount:async()=>{}},
 '@surefy/console/services/message.service':{sendMessage:async()=>{sends++;if(sendError)throw sendError;return {id:'message'};}},
 '@surefy/config/redis.config':{},uuid:{v4:()=> 'message-id'}};
 const exports={};const js=ts.transpileModule(fs.readFileSync('src/queues/processors/campaignExecution.processor.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText;
 vm.runInNewContext(js+';exports.sendOne=sendCampaignMessage;', {exports,require:n=>deps[n]||{},console:{log(){},info(){},error(){},warn(){}},setInterval:()=>({unref(){}}),clearInterval(){},process});
 const run=()=>exports.sendOne({id:'c',user_id:'u',company_id:'co',phone_number_id:'p'},{id:'cm',contact_id:'contact'}, {id:'contact',phone_number:'+6581234567',is_valid:true},{name:'test',language:'en',components:[]},{},()=>true);
 return {run,sends:()=>sends,statuses};
}
test('provider rate limit stays failed without a second send',async()=>{
 const h=worker({sendError:Object.assign(Error('rate limited'),{code:131056})});
 await h.run();await h.run();assert.equal(h.sends(),1);assert.deepEqual(h.statuses,['failed']);
});
test('accepted message with failed persistence cannot send again',async()=>{
 const h=worker({saveError:true});await assert.rejects(h.run(),/database write failed/);
 await h.run();assert.equal(h.sends(),1);
});
test('recipient that cannot be claimed is never sent',async()=>{
 const h=worker({claim:false});await h.run();assert.equal(h.sends(),0);
});
