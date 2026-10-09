const { test } = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const fs = require('node:fs');
const vm = require('node:vm');
class HttpError extends Error { constructor(data) { super(data.message); } }
function load(file, dependencies) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText, { exports, require: key => { assert.ok(key in dependencies, key); return dependencies[key]; } });
  return exports;
}
const validation = load('src/app/utils/templateValidation.ts', { '@surefy/exceptions/HTTP400Error': HttpError });
const body = [{type:'BODY',text:'Hello {{1}}!',example:{body_text:[['Sam']]}}];
const payload = {name:'order_update',language:'en_US',category:'UTILITY',components:body,waba_id:'waba',company_id:'company',user_id:'owner'};
const account = {companyId:'company',userId:'owner'};
function setup(overrides = {}) {
  const calls = [];
  const template = {id:'local',company_id:'company',waba_id:'waba',template_id:'meta',name:'order_update',language:'en_US'};
  const meta = {
    createTemplate: async (id, data) => {calls.push(['create',id,data]);return {id:'meta',status:'PENDING'};},
    getTemplate: async () => ({status:'APPROVED',category:'UTILITY',components:body}),
    updateTemplate: async (id,data) => {calls.push(['edit',id,data]);return {success:true};},
    deleteTemplate: async (...args) => calls.push(['delete',...args]),
    ...overrides.meta,
  };
  const model = {findByNameAndLanguage:async()=>null,create:async data=>data,findById:async()=>template,
    update:async(id,data)=>{calls.push(['save',id,data]);return data;},...overrides.model};
  const service = load('src/app/services/template.service.ts', {
    '@surefy/console/models/template.model':model,
    '@surefy/console/models/waba.model':{findById:async()=>({id:'waba',waba_id:'123',company_id:'company',user_id:'owner',...overrides.waba})},
    './meta.service':meta, '@surefy/exceptions/HTTP404Error':HttpError,'@surefy/exceptions/HTTP400Error':HttpError,
    '../models/phoneNumber.model':{}, '../utils/templateValidation':validation, uuid:{validate:()=>true},
  }).default;
  return {service,calls};
}
test('creation validates language, name and variable examples',()=>{
  for (const language of ['en_US','hi','mr','ar']) validation.validateTemplatePayload({...payload,language},true);
  for (const change of [{language:['en','hi']},{name:'Bad Name'},{components:[]},{components:[{type:'BODY',text:'Hello {{1}}'}]}]) {
    assert.throws(()=>validation.validateTemplatePayload({...payload,...change},true));
  }
  assert.throws(()=>validation.validateTemplatePayload({language:'hi'}));
  assert.throws(()=>validation.validateTemplatePayload({}));
});
test('language variants preserve content and owner, and duplicate variants fail before Meta',async()=>{
  const {service,calls}=setup();
  const created=await service.createTemplate({...payload,language:'hi'});
  assert.equal(created.language,'hi');assert.equal(created.waba_id,'waba');assert.equal(calls[0][1],'123');
  const duplicate=setup({model:{findByNameAndLanguage:async()=>({id:'existing'})}});
  await assert.rejects(duplicate.service.createTemplate(payload),/already exist/);
  assert.equal(duplicate.calls.length,0);
});
test('cross-account WABA cannot be used to create or edit',async()=>{
  const {service,calls}=setup({waba:{user_id:'someone-else'}});
  await assert.rejects(service.createTemplate(payload),/not found/);
  await assert.rejects(service.updateTemplate('local',{components:body},account),/not found/);
  assert.equal(calls.length,0);
});
test('update posts to Meta ID and refreshes state after marking changed content pending',async()=>{
  const {service,calls}=setup();
  await service.updateTemplate('local',{components:body},account);
  assert.equal(calls[0][0],'edit');assert.equal(calls[0][1],'meta');
  assert.equal(calls[1][2].status,'PENDING');assert.equal(calls[2][2].status,'APPROVED');
});
test('pending templates and approved category changes fail before edit',async()=>{
  const pending=setup({meta:{getTemplate:async()=>({status:'PENDING'})}});
  await assert.rejects(pending.service.updateTemplate('local',{components:body},account),/cannot be edited/);
  const approved=setup();
  await assert.rejects(approved.service.updateTemplate('local',{category:'MARKETING'},account),/category/);
  assert.equal(pending.calls.length,0);assert.equal(approved.calls.length,0);
});
test('Meta rejection does not modify local content',async()=>{
  const {service,calls}=setup({meta:{updateTemplate:async()=>{throw new Error('Meta rejected');}}});
  await assert.rejects(service.updateTemplate('local',{components:body},account),/Meta rejected/);
  assert.equal(calls.length,0);
});
test('deleting one language includes its Meta ID',async()=>{
  const {service,calls}=setup();
  await service.deleteTemplate('local',account);
  assert.deepEqual(Array.from(calls[0]),['delete','123','order_update','meta']);
});
