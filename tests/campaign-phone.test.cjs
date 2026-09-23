require('ts-node/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveCampaignPhone: resolve } = require('../src/app/utils/campaignPhone');
test('local numbers use saved country code and international numbers are preserved', () => {
  const contacts = [{ id: 'india', phone_number: '7579380000', country_code: '91' },
    { id: 'singapore', phone_number: '92956294', country_code: '65' }];
  assert.equal(resolve('7579380000', contacts).phone_number, '+917579380000');
  assert.equal(resolve('92956294', contacts).phone_number, '+6592956294');
  assert.equal(resolve('+6592956294', contacts).contact.id, 'singapore');
  assert.equal(resolve('6592956294', contacts).country_code, '65');
});
test('local input matches an already international saved contact', () => {
  assert.equal(resolve('92956294', [{ id: 'sg', phone_number: '+6592956294', country_code: '65' }]).phone_number, '+6592956294');
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
