require('ts-node/register');
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),ts=require('typescript');
class HttpError extends Error{constructor({message}){super(message);}}
function fixture({foreign=false,duplicate=false}={}){
 const contact={id:'contact',user_id:'u',company_id:'c',phone_number:'+919372597458',country_code:'91',phone_number_id:'sender',custom_fields:{}};
 let saved;
 const exports={};
 const deps={
 '../models/contact.model':{findById:async()=>contact,findOwnedByPhone:async()=>duplicate?{id:'other'}:contact,update:async(_id,data)=>{saved=data;return {...contact,...data};}},
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
