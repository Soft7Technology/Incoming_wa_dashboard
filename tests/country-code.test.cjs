require('ts-node/register');
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {normalizeCountryCodes, countryCodeFilterValues} = require('../src/app/utils/countryCode');
test('encoded and raw plus query values match both stored formats', () => {
  for (const value of ['91','+91',' 91']) assert.deepEqual(countryCodeFilterValues(value), ['91','+91']);
});
test('multiple country codes normalize and deduplicate', () => {
  assert.deepEqual(normalizeCountryCodes(['+91','91','+62']), ['91','62']);
});
test('reject invalid filter values', () => {
  for (const value of ['', '+', {}, [], '91abc']) assert.throws(()=>normalizeCountryCodes(value));
});
