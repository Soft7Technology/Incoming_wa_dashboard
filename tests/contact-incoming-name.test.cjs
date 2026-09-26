require('ts-node/register');
const phoneUtils = require('../src/app/utils/importPhone');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');
const knex=require('knex');
class HttpError extends Error {}
function setup(existing) {
  const db=knex({client:'pg'}), queries=[];
  db.client.runner=builder=>({run:async()=>{queries.push(builder.toSQL());return [{...existing,name:'Alice'}]}});
  class BaseModel {query(){return db('contacts')}}
  const exports={};
  const js=ts.transpileModule(fs.readFileSync('src/app/models/contact.model.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText;
  const deps={'@surefy/models/base.model':{BaseModel},'@surefy/exceptions/HTTP400Error':HttpError};
  vm.runInNewContext(js,{exports,require:id=>deps[id] || (id === '../utils/importPhone' ? phoneUtils : {}),console,Date});
  exports.default.findOwnedByPhone=async()=>existing;
  return {model:exports.default,queries,db};
}
const data={user_id:'owner',company_id:'company',phone_number_id:'business',phone_number:'919876543210',name:' Alice '};
test('incoming profile replaces blank and formatted numeric contact names within account scope',async()=>{
  for(const name of [null,'','  ','919876543210','+91 (98765) 43210','9876543210']) {
    const env=setup({id:'contact',name});
    try {
      const result=await env.model.findOrCreateIncoming(data);
      assert.equal(result.name,'Alice');
      const q=env.queries[0];
      for(const value of ['owner','company','business','contact','Alice']) assert.ok(q.bindings.includes(value));
      assert.match(q.sql,/"deleted_at" is null/);
      assert.match(q.sql,/"name" (?:= \?|is null)/);
    } finally {await env.db.destroy()}
  }
});
test('incoming messages preserve saved names and ignore unusable profile names',async()=>{
  for(const [name,profile] of [['Saved Name','Alice'],['',''],['',null],['','  '],['919876543210','+91 9876543210']]) {
    const existing={id:'contact',name},env=setup(existing);
    try {
      assert.equal(await env.model.findOrCreateIncoming({...data,name:profile}),existing);
      assert.equal(env.queries.length,0);
    } finally {await env.db.destroy()}
  }
});
test('new unnamed contact falls back to phone and later incoming profile can enrich it',async()=>{
  const env=setup(null);
  try {
    env.model.create=async value=>value;
    const created=await env.model.findOrCreateIncoming({...data,name:'  '});
    assert.equal(created.name,'9876543210');
    const named=await env.model.findOrCreateIncoming(data); assert.equal(named.name,'Alice');
  } finally {await env.db.destroy()}
});
test('concurrent contact creation still refreshes placeholder name',async()=>{
  const env=setup({id:'contact',name:data.phone_number});let lookups=0;
  env.model.findOwnedByPhone=async()=>++lookups===1?null:{id:'contact',name:data.phone_number};
  env.model.create=async()=>{throw new HttpError('duplicate')};
  try {assert.equal((await env.model.findOrCreateIncoming(data)).name,'Alice');assert.equal(env.queries.length,1)} finally {await env.db.destroy()}
});
