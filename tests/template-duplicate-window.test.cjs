const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function model(){
 const rows=[];let now=1000000,tail=Promise.resolve();
 const db={transaction:async fn=>{
  let unlock;const previous=tail;tail=new Promise(r=>unlock=r);await previous;
  const trx=()=>{const predicates=[];const q={
   where(obj,op,value){if(typeof obj==='object')predicates.push(r=>Object.entries(obj).every(([k,v])=>r[k]===v));else predicates.push(r=>r[obj]>value.cutoff);return q;},
   whereRaw(sql,args){if(sql.includes('regexp_replace'))predicates.push(r=>r.to_phone.replace(/\D/g,'')===args[0]);else predicates.push(r=>r.content.template.name===args[0]);return q;},
   first:async()=>rows.find(r=>predicates.every(p=>p(r)))
  };return q;};
  trx.raw=sql=>sql.includes('clock_timestamp')?{cutoff:now-300000}:Promise.resolve();
  try{return await fn(trx);}finally{unlock();}
 }};
 class BaseModel{constructor(){this.db=db;}async create(data){const row={...data,id:String(rows.length+1),created_at:now};rows.push(row);return row;}}
 const exports={};const js=ts.transpileModule(fs.readFileSync('src/app/models/message.model.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText;
 vm.runInNewContext(js,{exports,require:n=>n==='@surefy/models/base.model'?{BaseModel}:n==='@surefy/exceptions/HTTP400Error'?class extends Error{constructor(o){super(o.message);}}:{}});
 const send=(overrides={})=>exports.default.createOutbound({company_id:'co',phone_number_id:'sender',to_phone:'+6581234567',direction:'outbound',type:'template',status:'queued',content:{template:{name:'greeting',language:{code:'en'}}},...overrides});
 return {send,rows,advance:n=>now+=n};
}
test('concurrent campaigns can send the same template to the same recipient',async()=>{
 const h=model();const results=await Promise.allSettled([h.send({campaign_id:'one'}),h.send({campaign_id:'two',to_phone:'6581234567'})]);
 assert.equal(h.rows.length,2);assert.ok(results.every(result=>result.status==='fulfilled'));
});
test('direct template sends can repeat immediately including after a failed attempt',async()=>{
 const h=model();await h.send({status:'failed'});await h.send();await h.send();
 await h.send({content:{template:{name:'greeting',language:{code:'hi'},components:[]}}});
 assert.equal(h.rows.length,4);
});
test('campaign and direct sends do not block each other for the same template',async()=>{
 const h=model();await h.send();await h.send({campaign_id:'one'});await h.send();
 assert.equal(h.rows.length,3);
});
test('different recipients, senders, templates and companies remain independent',async()=>{
 const h=model();await h.send();await h.send({to_phone:'+6581234568'});await h.send({phone_number_id:'other'});await h.send({company_id:'other'});await h.send({content:{template:{name:'other'}}});assert.equal(h.rows.length,5);
});
test('same campaign cannot resend after the time window',async()=>{
 const h=model();await h.send({campaign_id:'one'});h.advance(300001);await assert.rejects(h.send({campaign_id:'one'}),{code:'CAMPAIGN_MESSAGE_EXISTS'});
});
test('ordinary text messages are not blocked by the template window',async()=>{
 const h=model();await h.send({type:'text'});await h.send({type:'text'});assert.equal(h.rows.length,2);
});
