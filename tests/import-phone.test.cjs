require('ts-node/register');
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {parseImportedPhone: parse} = require('../src/app/utils/importPhone');
test('detects international codes from the sample without adding default 91',()=>{
  for (const [number,code] of [['32470205982','32'],['33635295378','33'],['5521994774209','55'],['447391166058','44'],['573228398973','57']]) assert.equal(parse(number,'91').country_code,code);
});
test('national Indian number uses fallback',()=>assert.equal(parse('9687730639','91').phone_number,'+919687730639'));
test('explicit international prefix needs no default',()=>assert.equal(parse('0032470205982').country_code,'32'));
test('invalid number is rejected',()=>assert.throws(()=>parse('abc','91')));
test('ignores invisible directional marks copied with a number',()=>{
  assert.equal(parse('\u202a56971381606\u202c','91').country_code,'56');
  assert.equal(parse('8141322322\u202c','91').phone_number,'+918141322322');
});
