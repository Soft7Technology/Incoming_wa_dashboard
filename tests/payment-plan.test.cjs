const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),ts=require('typescript');
class HttpError extends Error{constructor({message}){super(message);}}
function load(file,deps={}){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,{exports,Date,Buffer,console,require:id=>id in deps?deps[id]:id.includes('/exceptions/')?HttpError:require(id)});return exports;}
const duration=load('src/app/utils/subscriptionDuration.ts');
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function harness(){
 let rows={companies:[{id:uuid(1),credit_balance:'1000.00'}],users:[{id:uuid(2),company_id:uuid(1),deleted_at:null},{id:uuid(3),company_id:uuid(9),deleted_at:null},{id:uuid(6),company_id:uuid(9),role:'superadmin',credit_balance:0,deleted_at:null}],
 subscription_plans:[{id:uuid(4),company_id:uuid(1),active:true,billing_cycle:'Monthly',price:'149.50',plan_name:'Business',features:{Contact:{limit_value:100}}}],
 credit_transactions:[],user_plans:[],company_payment_orders:[],company_payment_gateways:[{id:uuid(5),company_id:uuid(1),provider:'razorpay',mode:'live',active:true,credentials_encrypted:'encrypted'}]};
 let counter=100,paid=false,sends=0,fail=false;
 const db=table=>{
  const predicates=[];let operation,values;
  function execute(){if(operation==='insert'){const added=(Array.isArray(values)?values:[values]).map(v=>({id:uuid(counter++),...v}));rows[table].push(...added);operation=undefined;return added;}
   const selected=rows[table].filter(r=>predicates.every(p=>p(r)));if(operation==='update')selected.forEach(r=>Object.assign(r,values));return selected.map(r=>({...r}));}
  const q={where(data){predicates.push(r=>Object.entries(data).every(([k,v])=>r[k]===v));return q;},whereNull(key){predicates.push(r=>r[key]==null);return q;},andWhere(data){return q.where(data);},whereNot(key,v){predicates.push(r=>r[key]!==v);return q;},whereIn(key,values){predicates.push(r=>values.includes(r[key]));return q;},orderBy(){return q;},forShare(){return q;},forUpdate(){return q;},first(){return Promise.resolve(execute()[0]);},insert(v){operation='insert';values=v;return q;},update(v){operation='update';values=v;return q;},returning(){return Promise.resolve(execute());},then(resolve,reject){return Promise.resolve(execute()).then(resolve,reject);}};return q;};
 let tail=Promise.resolve();db.transaction=fn=>{const task=tail.then(async()=>{const snapshot=structuredClone(rows);try{return await fn(db);}catch(error){rows=snapshot;throw error;}});tail=task.catch(()=>{});return task;};
 const plans=load('src/app/services/paymentPlan.service.ts',{'../utils/subscriptionDuration':duration,'./planUsage.service':{countTeamSeats:async()=>2}});
 const service=load('src/app/services/companyPayment.service.ts',{'@surefy/database':db,'../models/companyPayment.model':load('src/app/models/companyPayment.model.ts',{'@surefy/database':db}).default,'./paymentPlan.service':plans.default,'../utils/paymentCredentials':{encryptPaymentCredentials:()=>'',decryptPaymentCredentials:()=>({})},'./paymentGateway.provider':{createGatewayOrder:async()=>{sends++;if(fail)throw Error('Timeout');return {provider_order_id:'order_'+sends,checkout:{}};},verifyGatewayOrder:async()=>paid}}).default;
 return {service,rows:()=>rows,paid:()=>{paid=true;},fail:()=>{fail=true;},sends:()=>sends,req:{companyId:uuid(1),userId:uuid(2),userRole:'admin',idempotencyKey:'one'},body:{mode:'live',subscription_plan_id:uuid(4)}};
}
test('order creates one pending snapshot at server price; retry preserves original price',async()=>{
 const h=harness();const first=await h.service.create(h.req,h.body);assert.equal(first.amount_paise,14950);assert.equal(h.rows().user_plans.length,1);assert.equal(h.rows().user_plans[0].active,false);assert.equal(h.rows().users[0].assigned_plan,undefined);
 h.rows().subscription_plans[0].price='999.00';const again=await h.service.create(h.req,h.body);assert.equal(again.id,first.id);assert.equal(again.amount_paise,14950);assert.equal(h.sends(),1);assert.equal(h.rows().user_plans.length,1);
});
test('verified live payment activates once and updates assigned_plan; duplicate verification never extends',async()=>{
 const h=harness();const order=await h.service.create(h.req,h.body);await h.service.verify(h.req,order.id);assert.equal(h.rows().user_plans[0].active,false);
 h.paid();const results=await Promise.all([h.service.verify(h.req,order.id),h.service.verify(h.req,order.id)]);assert.equal(results[0].status,'paid');assert.ok(results[0].fulfilled_at);assert.equal(h.rows().user_plans[0].status,'COMPLETED');assert.equal(h.rows().users[0].assigned_plan,order.user_plan_id);
 const end=h.rows().user_plans[0].end_date.getTime();await h.service.verify(h.req,order.id);assert.equal(h.rows().user_plans[0].end_date.getTime(),end);assert.equal(h.rows().user_plans.length,1);
});
test('rejects test-mode entitlement, client pricing and foreign plans/users before gateway calls',async()=>{
 for(const mutation of [{mode:'test'},{amount_paise:100},{user_id:uuid(3)},{subscription_plan_id:uuid(99)}]){const h=harness();await assert.rejects(h.service.create(h.req,{...h.body,...mutation}));assert.equal(h.sends(),0);assert.equal(h.rows().user_plans.length,0);}
});
test('gateway timeout keeps an inactive pending plan and does not duplicate the external order on retry',async()=>{
 const h=harness();h.fail();await assert.rejects(h.service.create(h.req,h.body),/Timeout/);assert.equal(h.rows().user_plans[0].active,false);assert.equal((await h.service.create(h.req,h.body)).status,'creation_unknown');assert.equal(h.sends(),1);
});
test('existing plan survives unpaid checkout and remaining paid duration carries over at activation',async()=>{
 const h=harness();const end=new Date(Date.now()+5*86400000);h.rows().user_plans.push({id:uuid(30),user_id:uuid(2),company_id:uuid(1),active:true,status:'COMPLETED',billing_cycle:'Monthly',end_date:end});
 const order=await h.service.create(h.req,h.body);assert.equal(h.rows().user_plans[0].active,true);h.paid();await h.service.verify(h.req,order.id);assert.equal(h.rows().user_plans[0].active,false);assert.equal(h.rows().user_plans[1].active,true);assert.ok(h.rows().user_plans[1].duration_days>=33);
});
test('fulfillment failure rolls back paid status and leaves existing entitlement intact',async()=>{
 const h=harness();const order=await h.service.create(h.req,h.body);h.rows().user_plans[0].price='1.00';h.paid();await assert.rejects(h.service.verify(h.req,order.id),/does not match/);assert.equal(h.rows().company_payment_orders[0].status,'pending');assert.equal(h.rows().user_plans[0].active,false);
});

test('Monthly and Yearly wallet thresholds accept equal/above and reject insufficient balances without side effects',async()=>{
 for(const [cycle,minimum] of [['Monthly',100],['Yearly',1000]]) {
  for(const balance of [minimum-0.01,minimum,minimum+1]) {
   const h=harness();h.rows().subscription_plans[0].billing_cycle=cycle;h.rows().companies[0].credit_balance=String(balance);
   if(balance<minimum){await assert.rejects(h.service.create(h.req,h.body),/credit balance/);assert.equal(h.sends(),0);assert.equal(h.rows().user_plans.length,0);assert.equal(h.rows().company_payment_orders.length,0);}
   else{await h.service.create(h.req,h.body);assert.equal(h.sends(),1);}
   assert.equal(h.rows().companies[0].credit_balance,String(balance));
  }
 }
});
test('invalid wallet balances and client-supplied balances cannot bypass order validation',async()=>{
 for(const balance of [null,undefined,'','invalid','Infinity',-1]) {
  const h=harness();h.rows().companies[0].credit_balance=balance;
  await assert.rejects(h.service.create(h.req,{...h.body,credit_balance:99999,balance_after:99999,company_id:uuid(9)}),/credit balance/);
  assert.equal(h.sends(),0);assert.equal(h.rows().user_plans.length,0);
 }
});
test('retrying an existing order still returns it if company balance later drops',async()=>{
 const h=harness();const order=await h.service.create(h.req,h.body);h.rows().companies[0].credit_balance='0';
 assert.equal((await h.service.create(h.req,h.body)).id,order.id);assert.equal(h.sends(),1);
});

test('paid Monthly/Yearly subscriptions transfer platform fee once with balance_before/after ledger',async()=>{
 for(const [cycle,fee] of [['Monthly',100],['Yearly',1000]]) {
  const h=harness();h.rows().subscription_plans[0].billing_cycle=cycle;
  const order=await h.service.create(h.req,h.body);assert.equal(h.rows().credit_transactions.length,0);
  await h.service.verify(h.req,order.id);assert.equal(h.rows().credit_transactions.length,0);
  h.paid();await Promise.all([h.service.verify(h.req,order.id),h.service.verify(h.req,order.id)]);
  await h.service.verify(h.req,order.id);
  assert.equal(h.rows().companies[0].credit_balance,1000-fee);
  assert.equal(h.rows().users.find(u=>u.role==='superadmin').credit_balance,fee);
  const entries=h.rows().credit_transactions;assert.equal(entries.length,2);
  assert.equal(entries[0].amount,-fee);assert.equal(entries[0].balance_before,1000);assert.equal(entries[0].balance_after,1000-fee);
  assert.ok(entries[0].description.includes(order.id));assert.equal(entries[1].amount,fee);
 }
});
test('insufficient balance at verification rolls back; top-up and same-order retry charges once',async()=>{
 const h=harness();const order=await h.service.create(h.req,h.body);h.rows().companies[0].credit_balance='99';h.paid();
 await assert.rejects(h.service.verify(h.req,order.id),/Top up and verify/);
 assert.equal(h.rows().credit_transactions.length,0);assert.equal(h.rows().user_plans[0].active,false);assert.equal(h.rows().companies[0].credit_balance,'99');
 h.rows().companies[0].credit_balance='100';await h.service.verify(h.req,order.id);
 assert.equal(h.rows().companies[0].credit_balance,0);assert.equal(h.rows().credit_transactions.length,2);assert.equal(h.rows().user_plans[0].active,true);
});
