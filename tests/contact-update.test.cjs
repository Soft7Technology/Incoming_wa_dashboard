require('ts-node/register');
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),ts=require('typescript');
class HttpError extends Error{constructor({message}){super(message);}}
function fixture({foreign=false,duplicate=false,stored={}}={}){
 const contact={id:'contact',user_id:'u',company_id:'c',phone_number:'+919372597458',country_code:'91',phone_number_id:'sender',custom_fields:{},...stored};
 let saved;
 const exports={};
 const deps={
 '../models/contact.model':{findById:async()=>contact,findOwnedByPhone:async()=>duplicate?{id:'other'}:contact,update:async(_id,data)=>{
  assert.ok(data.invalid_reason == null || ['not_whatsapp','invalid_format','blocked','opted_out','other'].includes(data.invalid_reason),
   'invalid_reason must satisfy the database check constraint');
  saved=data;return {...contact,...data};}},
 '../models/phoneNumber.model':{findByPhoneNumberId:async()=>({id:'sender',user_id:foreign?'other':'u',company_id:'c'})},
 '../utils/importPhone':require('../src/app/utils/importPhone'),
 '../utils/contactCustomFields':{parseContactCustomFields:value=>value},
 };
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/services/contact.service.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,{exports,require:name=>deps[name]||(name.includes('Error')?HttpError:{}),console});
 return {service:exports.default,saved:()=>saved};
}
test('contact update saves normalized recipient number, sender ID and opt-in state',async()=>{
 const f=fixture();
 const result=await f.service.updateContact('u','contact',{name:'parth2333',phone_number:'+919372597455',phone_number_id:'sender',country_code:'91',is_opted_out:false});
 assert.equal(result.phone_number,'+919372597455');
 assert.equal(result.phone_number_id,'sender');
 assert.equal(result.is_opted_out,false);
});
test('foreign sender, duplicate identity and nonboolean opt-out reject before update',async()=>{
 for(const [options,data,pattern] of [[{foreign:true},{phone_number_id:'sender'},/your account/],[{duplicate:true},{phone_number:'+919372597455'},/already exists/],[{},{is_opted_out:'false'},/true or false/]]){
  const f=fixture(options);await assert.rejects(f.service.updateContact('u','contact',data),pattern);assert.equal(f.saved(),undefined);
 }
});
test('profile-only update preserves phone and opt-out fields',async()=>{
 const f=fixture();await f.service.updateContact('u','contact',{name:'Updated'});
 assert.equal(f.saved().phone_number,undefined);assert.equal(f.saved().is_opted_out,undefined);
});

test('assigning an unresolved contact with a full edit form preserves invalid phone flags',async()=>{
 const stored={phone_number:'+9872661415',country_code:null,is_valid:false,invalid_reason:null};
 const f=fixture({stored});
 const result=await f.service.updateContact('u','contact',{name:'Vikas Chawla',phone_number:stored.phone_number,
  country_code:null,assigned_to:['96904e53-b277-468b-b622-ed65a062fcd1']});
 assert.equal(result.phone_number,stored.phone_number);assert.equal(result.country_code,null);
 assert.equal(result.is_valid,false);assert.equal(result.invalid_reason,null);
 assert.equal(f.saved().is_valid,undefined);
 assert.deepEqual(Array.from(result.assigned_to),['96904e53-b277-468b-b622-ed65a062fcd1']);
});

test('editing an invalid number uses the allowed invalid_format reason',async()=>{
 const f=fixture();
 const result=await f.service.updateContact('u','contact',{phone_number:'+9872661415',assigned_to:[]});
 assert.equal(result.phone_number,'+9872661415');assert.equal(result.country_code,null);
 assert.equal(result.is_valid,false);assert.equal(result.invalid_reason,'invalid_format');
});

test('adding country information rebuilds unresolved phones and saves both columns',async()=>{
 for(const number of ['+9896370801','+9872661415']){
  const f=fixture({stored:{phone_number:number,country_code:null,is_valid:false}});
  const result=await f.service.updateContact('u','contact',{phone_number:number,country_code:'91',assigned_to:[]});
  assert.equal(result.phone_number,'+91'+number.slice(1));assert.equal(result.country_code,'91');
  assert.equal(result.is_valid,true);assert.equal(result.invalid_reason,null);
 }
 const invalid=fixture({stored:{phone_number:'+1234',country_code:null,is_valid:false}});
 const result=await invalid.service.updateContact('u','contact',{country_code:'91'});
 assert.equal(result.phone_number,'+911234');assert.equal(result.country_code,'91');
 assert.equal(result.is_valid,false);assert.equal(result.invalid_reason,'invalid_format');
});

test('changing country alone replaces the old prefix and unchanged numbers preserve WhatsApp failures',async()=>{
 const f=fixture({stored:{phone_number:'+17579380000',country_code:'1'}});
 const result=await f.service.updateContact('u','contact',{country_code:'+91'});
 assert.equal(result.phone_number,'+917579380000');assert.equal(result.country_code,'91');
 const blocked=fixture({stored:{is_valid:false,invalid_reason:'blocked'}});
 const unchanged=await blocked.service.updateContact('u','contact',{phone_number:'+919372597458',country_code:'IN',name:'Updated'});
 assert.equal(unchanged.is_valid,false);assert.equal(unchanged.invalid_reason,'blocked');
 assert.equal(blocked.saved().is_valid,undefined);
});

test('invalid country codes and duplicates after rebuilding the prefix reject before saving',async()=>{
 for(const country_code of ['9','999','invalid',{},['91'],0]){
  const f=fixture();await assert.rejects(f.service.updateContact('u','contact',{country_code}),/Country code/);
  assert.equal(f.saved(),undefined);
 }
 const f=fixture({duplicate:true,stored:{phone_number:'+9896370801',country_code:null}});
 await assert.rejects(f.service.updateContact('u','contact',{country_code:'91'}),/already exists/);
 assert.equal(f.saved(),undefined);
});

test('country edits avoid duplicate prefixes and normalize national trunk zeros',async()=>{
 for(const [phone_number,country_code,expected,valid] of [
  ['+919372597455','91','+919372597455',true],
  ['00919372597455','91','+919372597455',true],
  ['919372597455','IN','+919372597455',true],
  ['07391166058','GB','+447391166058',true],
  ['+911234','91','+911234',false],
 ]){
  const f=fixture();
  const result=await f.service.updateContact('u','contact',{phone_number,country_code});
  assert.equal(result.phone_number,expected);assert.equal(result.is_valid,valid);
  assert.equal(result.invalid_reason,valid?null:'invalid_format');
 }
});
