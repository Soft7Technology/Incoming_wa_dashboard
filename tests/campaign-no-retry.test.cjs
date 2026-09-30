const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function worker({sendError,saveError,claim=true,failFirst=0,statusError=false}={}) {
 let sends=0;const claimed=new Set();const statuses=[];
 class Worker{on(){return this;}}
 const deps={bullmq:{Worker,DelayedError:class extends Error{}},'../campaignExecution.queue':{campaignExecutionQueue:{}},
 '../campaignCapacity':{campaignCapacity:{concurrency:1},createCapacitySampler:()=>({})},
 '../campaignPacing':{waitForCampaignPermit:async()=>true},'../campaignUserSlots':{},
 '../campaignDatabaseError':{isConnectionAcquireError:()=>false},
 '../../app/utils/campaignPhone':{campaignRecipientNumber:n=>n.replace('+','')},
 '@surefy/console/app/utils/messageError':{getMessageError:e=>({error_code:String(e.code||'UNKNOWN'),error_message:e.message})},
 '@surefy/console/models/campaignMessage.model':{
 claimSingleAttempt:async(id)=>{if(!claim||claimed.has(id))return false;claimed.add(id);return true;},
 recordSent:async()=>{if(saveError)throw Error('database write failed');},
 updateStatus:async(id,status)=>{if(statusError)throw Error('status database failure');statuses.push(status);}},
 '@surefy/console/models/campaign.model':{incrementCount:async()=>{}},
 '@surefy/console/models/contact.model':{incrementFailedCount:async()=>{}},
 '@surefy/console/services/message.service':{sendMessage:async()=>{sends++;if(sendError)throw sendError;if(sends<=failFirst)throw Error('recipient rejected');return {id:'message'};}},
 '@surefy/config/redis.config':{},uuid:{v4:()=> 'message-id'}};
 const exports={};const js=ts.transpileModule(fs.readFileSync('src/queues/processors/campaignExecution.processor.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText;
 vm.runInNewContext(js+';exports.sendOne=sendCampaignMessage;', {exports,require:n=>deps[n]||{},console:{log(){},info(){},error(){},warn(){}},setInterval:()=>({unref(){}}),clearInterval(){},process});
 const run=(id='cm')=>exports.sendOne({id:'c',user_id:'u',company_id:'co',phone_number_id:'p'},{id,contact_id:'contact'}, {id:'contact',phone_number:'+6581234567',is_valid:true},{name:'test',language:'en',components:[]},{},()=>true);
 return {run,sends:()=>sends,statuses};
}
test('provider rate limit stays failed without a second send',async()=>{
 const h=worker({sendError:Object.assign(Error('rate limited'),{code:131056})});
 await h.run();await h.run();assert.equal(h.sends(),1);assert.deepEqual(h.statuses,['failed']);
});
test('accepted message with failed persistence cannot send again',async()=>{
 const h=worker({saveError:true});await h.run();
 await h.run();assert.equal(h.sends(),1);
});
test('recipient that cannot be claimed is never sent',async()=>{
 const h=worker({claim:false});await h.run();assert.equal(h.sends(),0);
});

test('ten failed recipients do not prevent sending the next recipient and are not resent',async()=>{
 const h=worker({failFirst:10});
 for(let i=0;i<11;i++)await h.run(String(i));
 assert.equal(h.sends(),11);assert.equal(h.statuses.length,10);
 for(let i=0;i<11;i++)await h.run(String(i));
 assert.equal(h.sends(),11);
});
test('failed outcome persistence keeps reservation and allows remaining recipients',async()=>{
 const h=worker({saveError:true,statusError:true});
 await h.run('first');await h.run('second');await h.run('first');
 assert.equal(h.sends(),2);
});
