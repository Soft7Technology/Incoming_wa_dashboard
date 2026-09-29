const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
const code=fs.readFileSync('docs/subscription-checkout.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
function page(paid=true){
 const nodes=Object.fromEntries(['origin','token','phone','plan','recipient','pay','verify','reset','form','result'].map(id=>[id,{value:'',disabled:false}]));
 nodes.origin.value='https://api.example.test';nodes.token.value='jwt';nodes.phone.value='9999999999';nodes.plan.value='plan-uuid';nodes.recipient.value='user-uuid';
 const calls=[];let checkout;
 class Razorpay{constructor(options){checkout=options;}on(){}open(){checkout.handler();}}
 vm.runInNewContext(code,{document:{getElementById:id=>nodes[id]},URL,AbortSignal,crypto:{randomUUID:()=> 'attempt'},setTimeout:fn=>fn(),window:{Razorpay},fetch:async(url,options)=>{
 calls.push({url,body:JSON.parse(options.body),headers:options.headers});const verified=url.endsWith('/verify');
 return {ok:true,json:async()=>({success:true,data:{id:'local-uuid',user_plan_id:'user-plan-uuid',is_test:false,amount_paise:14950,status:verified&&paid?'paid':'pending',fulfilled_at:verified&&paid?'2026-09-28':null,checkout:{provider:'razorpay',mode:'live',order_id:'order_razorpay',amount:14950,currency:'INR',key:'public'}}})};}});
 return {nodes,calls,checkout:()=>checkout,run:()=>nodes.form.onsubmit({preventDefault(){}})};
}
test('subscription checkout creates server-priced order and auto-verifies local ID after payment',async()=>{
 const h=page();await h.run();assert.equal(h.calls.length,2);
 assert.deepEqual(h.calls[0].body,{mode:'live',subscription_plan_id:'plan-uuid',customer_phone:'9999999999',user_id:'user-uuid'});
 assert.ok(h.calls[1].url.endsWith('/orders/local-uuid/verify'));assert.equal(h.checkout().order_id,'order_razorpay');assert.equal(h.checkout().amount,14950);
 assert.ok(h.nodes.result.textContent.includes('Your subscription is active'));assert.equal(h.nodes.pay.disabled,true);
});
test('pending confirmation retries verification only, never creates another order',async()=>{
 const h=page(false);await h.run();assert.equal(h.calls.filter(c=>c.url.endsWith('/orders')).length,1);assert.equal(h.calls.filter(c=>c.url.endsWith('/verify')).length,12);
 assert.ok(!h.nodes.result.textContent.includes('Your subscription is active'));assert.equal(h.nodes.verify.disabled,false);
});
