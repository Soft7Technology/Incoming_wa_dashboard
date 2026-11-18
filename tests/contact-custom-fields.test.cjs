const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
class HttpError extends Error { constructor({message}) { super(message); } }
function load(file, deps) {
 const exports={};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true},
 }).outputText,{exports,require:name=>deps[name] || {}});
 return exports;
}
const fields=load('src/app/utils/contactCustomFields.ts',{'@surefy/exceptions/HTTP400Error':HttpError});
const plain=value=>JSON.parse(JSON.stringify(value));

test('editing imported attributes merges both columns without losing unrelated values',()=>{
 const stored={attributes:{'Check-In Date':'20 Nov','Check-Out Date':'24 Nov'},custom_fields:{meal:'Veg'}};
 const result=fields.synchronizedContactFields({custom_fields:{' check-in date ':'21 Nov',amount:0,active:false}},stored);
 assert.deepEqual(plain(result.attributes),{'Check-In Date':'21 Nov','Check-Out Date':'24 Nov',meal:'Veg',amount:0,active:false});
 assert.deepEqual(plain(result.attributes),plain(result.custom_fields));
 assert.equal(stored.attributes['Check-In Date'],'20 Nov');
});

test('a later import replaces edited values and does not create case-duplicate keys',()=>{
 const result=fields.synchronizedContactFields({attributes:{'Check-in Date':'22 Nov'}},
  {attributes:{'Check-In Date':'20 Nov'},custom_fields:{'Check-In Date':'21 Nov',meal:'Veg'}});
 assert.deepEqual(plain(result.attributes),{'Check-In Date':'22 Nov',meal:'Veg'});
 assert.deepEqual(plain(result.attributes),plain(result.custom_fields));
});

test('conflicting aliases in one request are rejected instead of silently choosing a value',()=>{
 for(const input of [
  {attributes:{Date:'20 Nov',date:'21 Nov'}},
  {attributes:{Date:'20 Nov'},custom_fields:{date:'21 Nov'}},
 ]) assert.throws(()=>fields.synchronizedContactFields(input),/Conflicting values/);
 assert.deepEqual(plain(fields.synchronizedContactFields({attributes:{Date:'20 Nov',date:'20 Nov'}}).attributes),{Date:'20 Nov'});
});

test('field parsing accepts legacy JSON and preserves literal dotted keys and explicit null',()=>{
 const result=fields.synchronizedContactFields({custom_fields:'{" ORDER.Total ":0,"date":null}'},
  {attributes:'{"order.total":99,"Date":"20 Nov"}'});
 assert.deepEqual(plain(result.attributes),{'order.total':0,Date:null});
 assert.throws(()=>fields.synchronizedContactFields({attributes:'{bad'}),/valid JSON/);
 assert.throws(()=>fields.synchronizedContactFields({attributes:{'  ':1}}),/cannot be empty/);
 assert.deepEqual(plain(fields.synchronizedContactFields({name:'New name'})),{});
});

function modelFixture(stored={id:'contact'}) {
 const writes=[];
 const transaction=()=>({where(){return this},whereNull(){return this},first:async()=>undefined});
 transaction.raw=async()=>{};
 class BaseModel {
  constructor(){this.db={transaction:fn=>fn(transaction)}}
  async findById(){return stored}
  async create(data){writes.push(data);return data}
  async update(id,data){writes.push(data);return {id,...data}}
  query(){return {insert:data=>({returning:async()=>{writes.push(...data);return data}})}}
 }
 const model=load('src/app/models/contact.model.ts',{
  '@surefy/models/base.model':{BaseModel},'../utils/contactCustomFields':fields,
  '../utils/importPhone':{parseStoredContactPhone:phone_number=>({phone_number})},
  '@surefy/exceptions/HTTP400Error':HttpError,
 }).default;
 return {model,writes};
}

test('contact creation and bulk creation persist equal attribute columns',async()=>{
 const {model,writes}=modelFixture();
 await model.create({user_id:'u',company_id:'c',phone_number:'123',attributes:{'Check-In Date':'20 Nov'}});
 await model.bulkCreate([{phone_number:'456',custom_fields:{'Check-Out Date':'24 Nov'}}]);
 assert.equal(writes.length,2);
 for(const row of writes) assert.deepEqual(plain(row.attributes),plain(row.custom_fields));
 assert.equal(writes[0].custom_fields['Check-In Date'],'20 Nov');
});

test('model updates synchronize imports and edits, but unrelated updates leave fields alone',async()=>{
 const {model,writes}=modelFixture({id:'contact',attributes:{'Check-In Date':'20 Nov'},custom_fields:{meal:'Veg'}});
 await model.update('contact',{custom_fields:{'Check-in Date':'21 Nov'}});
 assert.deepEqual(plain(writes[0].attributes),{'Check-In Date':'21 Nov',meal:'Veg'});
 assert.deepEqual(plain(writes[0].attributes),plain(writes[0].custom_fields));
 await model.update('contact',{name:'Updated'});
 assert.equal(writes[1].attributes,undefined);
 await assert.rejects(model.update('contact',{attributes:{Date:1,date:2}}),/Conflicting values/);
 assert.equal(writes.length,2);
});
