const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
const code=fs.readFileSync('docs/payment-test.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
function page(outcome='completed', paidAfter=2, timeout=false){
 const ids=['origin','token','phone','mode','amount','modeNote','pay','verify','reset','form','result','plan','recipient'];
 const elements=Object.fromEntries(ids.map(id=>[id,{value:'',disabled:false}]));
 elements.origin.value='https://example.test';elements.token.value='jwt';elements.phone.value='9999999999';elements.mode.value='live';elements.amount.value='100';
 let checks=0,creates=0,closed=false;const calls=[];
 class Razorpay {constructor(options){this.options=options;}on(name,handler){this.failed=handler;}close(){closed=true;}open(){if(outcome==='completed')this.options.handler();else if(outcome==='failed')this.failed();else this.options.modal.ondismiss();}}
 vm.runInNewContext(code,{document:{getElementById:id=>elements[id]},crypto:{randomUUID:()=> 'attempt'},URL,AbortSignal,setTimeout:fn=>{fn();},window:{Razorpay},fetch:async(url,options)=>{
 calls.push({url,options});const verifying=url.endsWith('/verify');if(verifying)checks++;else creates++;
 if(verifying&&timeout){const error=new Error('network stalled');error.name='TimeoutError';throw error;}
 return {ok:true,json:async()=>({success:true,data:{id:'local',is_test:false,amount_paise:100,status:verifying&&checks>=paidAfter?'paid':'pending',checkout:{provider:'razorpay',mode:'live',key:'public',order_id:'order_provider',amount:100,currency:'INR'}}})};}});
 return {elements,run:()=>elements.form.onsubmit({preventDefault(){}}),state:()=>({checks,creates,closed,calls})};
}
test('live success polls existing order until paid and releases page controls',async()=>{const h=page();await h.run();assert.equal(h.state().creates,1);assert.equal(h.state().checks,2);assert.ok(h.elements.result.textContent.includes('paid'));assert.equal(h.elements.pay.disabled,false);assert.ok(h.state().calls.every(c=>c.options.signal));});
test('pending live payment polling is bounded and never creates another order',async()=>{const h=page('completed',99);await h.run();assert.equal(h.state().checks,12);assert.equal(h.state().creates,1);assert.ok(h.elements.result.textContent.includes('Do not pay again'));});
test('verification timeout preserves order and releases controls for manual retry',async()=>{const h=page('completed',2,true);await h.run();assert.ok(h.elements.result.textContent.includes('timed out'));assert.ok(h.elements.result.textContent.includes('local'));assert.equal(h.elements.verify.disabled,false);assert.equal(h.elements.reset.disabled,false);});
test('dismissal and failed checkout still verify provider status',async()=>{for(const outcome of ['dismissed','failed']){const h=page(outcome,1);await h.run();assert.equal(h.state().checks,1);assert.equal(h.elements.pay.disabled,false);if(outcome==='failed')assert.equal(h.state().closed,true);}});
