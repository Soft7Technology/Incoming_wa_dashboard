require('ts-node/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveCampaignPhone: resolve } = require('../src/app/utils/campaignPhone');
test('local numbers use saved country code and international numbers are preserved', () => {
  const contacts = [{ id: 'india', phone_number: '7579380000', country_code: '91' },
    { id: 'singapore', phone_number: '92956294', country_code: '65' }];
  assert.equal(resolve('7579380000', contacts).phone_number, '7579380000');
  assert.equal(resolve('92956294', contacts).phone_number, '92956294');
  assert.equal(resolve('+6592956294', contacts).contact.id, 'singapore');
  assert.equal(resolve('6592956294', contacts).country_code, '65');
});
test('local input matches an already international saved contact', () => {
  assert.equal(resolve('92956294', [{ id: 'sg', phone_number: '+6592956294', country_code: '65' }]).phone_number, '92956294');
});
test('explicit country code is not replaced and unknown local numbers require context', () => {
  assert.equal(resolve('+447391166058', []).country_code, '44');
  assert.throws(() => resolve('12345', []));
});

test('shared national digits across countries require an explicit country prefix', () => {
  assert.throws(() => resolve('7579380000', [
    { id: 'in', phone_number: '+917579380000', country_code: '91' },
    { id: 'us', phone_number: '+17579380000', country_code: '1' },
  ]), /Multiple contacts/);
});


test('campaign creation accepts international digits with or without plus', () => {
  for (const value of ['+919372597458', '919372597458', '+65 8123 4567', '6581234567', '006581234567']) {
    const parsed = resolve(value, [], { allowBareInternational: true });
    assert.equal(parsed.phone_number, value.includes('9372597458') ? '9372597458' : '81234567');
  }
});
test('campaign creation accepts national numbers with supplied country or saved context', () => {
  assert.equal(resolve('9372597458', [], { countryCode: '+91', allowBareInternational: true }).country_code, '91');
  assert.equal(resolve('81234567', [], { countryCode: 'SG', allowBareInternational: true }).country_code, '65');
  assert.throws(() => resolve('81234567', [], { allowBareInternational: true }));
  assert.equal(resolve('9522007000', [], { countryCode: '91', allowBareInternational: true }).country_code, '91');
});
test('campaign phone payload validation rejects malformed arrays and unsafe numbers', () => {
  const { validateCampaignPhoneInputs: validate } = require('../src/app/utils/campaignPhone');
  for (const contactNumber of ['919372597458', [], ['abc'], [null], [1.5], [Infinity], [{}]]) {
    assert.throws(() => validate({ contactNumber }));
  }
  assert.doesNotThrow(() => validate({ contactNumber: [919372597458, '+6581234567', '81234567'] }, '+65'));
});

const {resolveOptionalCampaignPhone, campaignRecipientNumber}=require('../src/app/utils/campaignPhone');
test('campaigns retain unresolved numbers without guessing a country',()=>{
 for(const input of ['9372597458','+9372597458']) {
  const result=resolveOptionalCampaignPhone(input,[]);
  assert.equal(result.country_code,null);
  assert.equal(campaignRecipientNumber(result.phone_number,result.country_code),'9372597458');
 }
 assert.equal(campaignRecipientNumber('+919372597458','91'),'919372597458');
 assert.equal(campaignRecipientNumber('9372597458','91'),'919372597458');
 for(const input of ['abc','12+345','1234567890123456']) assert.throws(()=>resolveOptionalCampaignPhone(input,[]));
});
