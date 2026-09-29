require('ts-node/register');
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),ts=require('typescript');
const phone=require('../src/app/utils/importPhone');
class HttpError extends Error{constructor({message}){super(message);}}
function harness(){
 const rows=[{id:'a',company_id:'c',user_id:'u',phone_number_id:'p',country_code:'65',phone_number:'+6581234567',is_opted_out:false},
 {id:'b',company_id:'c',user_id:'u',phone_number_id:'p2',country_code:'65',phone_number:'+6581234567',is_opted_out:false},
 {id:'d',company_id:'d',user_id:'v',phone_number_id:'p',country_code:'65',phone_number:'+6581234567',is_opted_out:false}];
 const db=()=>{let conditions={};const query={select(){return query;},whereNull(){return query;},whereRaw(){return query;},where(values){Object.assign(conditions,values);return query;},update:async values=>{rows.filter(row=>Object.entries(conditions).every(([k,v])=>row[k]===v)).forEach(row=>Object.assign(row,values));},first:async()=>rows.find(row=>Object.entries(conditions).every(([k,v])=>row[k]===v)),then(resolve){return Promise.resolve(rows.filter(row=>Object.entries(conditions).every(([k,v])=>row[k]===v))).then(resolve);}};return query;};
 const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/services/contactOptOut.service.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,{exports,Date,Set,require:id=>({'@surefy/database':db,'../utils/importPhone':phone,'@surefy/exceptions/HTTP400Error':HttpError,'@surefy/exceptions/HTTP404Error':HttpError,'../models/phoneNumber.model':{findByPhoneNumberId:async()=>({id:'p',company_id:'c',user_id:'u'})}}[id])});
 return {...exports,rows};
}
test('whole-message keywords normalize case and whitespace; unmatched text does not change preference',()=>{
 const h=harness();const config={opt_in_keywords:['join me'],opt_out_keywords:['STOP']};
 assert.equal(h.keywordDecision(config,{text:{body:' stop '}}),true);assert.equal(h.keywordDecision(config,{text:{body:'JOIN   ME'}}),false);
 assert.equal(h.keywordDecision(config,{text:{body:'please stop'}}),undefined);assert.equal(h.keywordDecision(config,{text:{body:'YES'}}),undefined);
 assert.equal(h.keywordDecision(config,{interactive:{button_reply:{id:'STOP',title:'anything'}}}),true);
});
test('keyword configuration rejects overlap and malformed lists',()=>{
 const h=harness();assert.throws(()=>h.validateKeywords({opt_in_keywords:[' START '],opt_out_keywords:['start']}),/overlap/);
 assert.throws(()=>h.validateKeywords({opt_in_keywords:'start',opt_out_keywords:[]}),/arrays/);
 assert.equal(h.validateKeywords({opt_in_keywords:['start','START'],opt_out_keywords:['stop']}).opt_in_keywords.length,1);
});
test('incoming STOP and START update only the receiving number/account and campaign guard reads current flag',async()=>{
 const h=harness(),business={id:'p',company_id:'c',user_id:'u'};
 await h.default.incoming(business,h.rows[0],{text:{body:'STOP'}});
 assert.equal(h.rows[0].is_opted_out,true);assert.equal(h.rows[1].is_opted_out,false);assert.equal(h.rows[2].is_opted_out,false);
 assert.equal(await h.default.isBlocked(business,'6581234567'),true);
 assert.equal((await h.default.excluded('c','u','p')).has('6581234567'),true);
 await h.default.incoming(business,h.rows[0],{text:{body:'START'}});
 assert.equal(await h.default.isBlocked(business,'6581234567'),false);
 assert.equal(await h.default.incoming(business,h.rows[0],{text:{body:'hello'}}),false);
});

test('malformed stored keyword JSON and non-string entries do not break incoming handling',()=>{
 const h=harness();
 assert.equal(h.keywordDecision({opt_out_keywords:'{bad json',opt_in_keywords:[null,1]},{text:{body:'hello'}}),undefined);
 assert.equal(h.keywordDecision({opt_out_keywords:[null,'stop'],opt_in_keywords:[]},{text:{body:'STOP'}}),true);
 assert.equal(h.keywordDecision({opt_out_keywords:[],opt_in_keywords:[]},{text:{body:'STOP'}}),undefined);
});
test('settings reads enforce company and owner scope and return consistent defaults',async()=>{
 const h=harness();
 const settings=await h.default.getKeywords({companyId:'c',ownerId:'u',actorId:'u'},'p');
 assert.equal(settings.opt_in_keywords[0],'START');
 await assert.rejects(h.default.getKeywords({companyId:'foreign',ownerId:'u',actorId:'u'},'p'),/not found/);
 await assert.rejects(h.default.getKeywords({companyId:'c',ownerId:'foreign',actorId:'foreign'},'p'),/not found/);
 await assert.rejects(h.default.getKeywords({companyId:'',ownerId:'u',actorId:'u'},'p'),/context/);
});
test('incoming commands reject mismatched receiving scope without changing contacts',async()=>{
 const h=harness();await assert.rejects(h.default.incoming({id:'p2',company_id:'c',user_id:'u'},h.rows[0],{text:{body:'STOP'}}),/does not match/);
 assert.equal(h.rows[0].is_opted_out,false);
});
test('invalid API preference and normalized oversized keyword inputs return validation errors',async()=>{
 const h=harness();
 for(const body of [null,[],true]) assert.throws(()=>h.validateKeywords(body),/arrays/);
 await assert.rejects(h.default.updateContact({companyId:'c',ownerId:'u',actorId:'u'},'bad-id','false'),/true or false/);
 await assert.rejects(h.default.updateContact({companyId:'c',ownerId:'u',actorId:'u'},'bad-id',false),/Invalid contact ID/);
 assert.throws(()=>h.validateKeywords({opt_in_keywords:['\u00df'.repeat(50)],opt_out_keywords:[]}),/maximum 80/);
});
