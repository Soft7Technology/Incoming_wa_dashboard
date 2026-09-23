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

test('expands scientific text without changing digits and supports numeric Excel cells', () => {
  for (const value of ['9.19372597458E+11', '9.1937259745800e11', '9193725974580E-1', 919372597458]) {
    assert.equal(parse(value, '91').phone_number, '+919372597458');
  }
  assert.equal(parse('9.687730639e9', '91').phone_number, '+919687730639');
  assert.equal(parse('3.2470205982E10', '91').phone_number, '+32470205982');
});
test('rejects fractional, unsafe and oversized scientific phone values', () => {
  for (const value of ['9.193725974581E11', '1e99999999', '1e-999999', '-9.19372597458E11', 919372597458.5, Infinity, NaN, 1234567890123456]) {
    assert.throws(() => parse(value, '91'));
  }
});
test('Excel import uses raw numeric cells and expands text scientific notation', async () => {
  const XLSX = require('xlsx');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const parser = require('../src/app/services/xlsxParser.service').default;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-import-'));
  const file = path.join(dir, 'phones.xlsx');
  try {
    const sheet = XLSX.utils.aoa_to_sheet([
      ['phone', 'name'], [919372597458, 'Numeric'], ['9.19372597458E+11', 'Text'], ['9.193725974581E11', 'Fraction'],
    ]);
    sheet.A2.z = '0.00E+00';
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Contacts');
    XLSX.writeFile(workbook, file);
    const result = await parser.parseContactsFromFile(file, '91', 'phone', 'name');
    assert.equal(result.valid, 2);
    assert.equal(result.invalid, 1);
    assert.deepEqual(result.contacts.map(row => row.phone_number), ['+919372597458', '+919372597458']);
    assert.equal(result.errors[0].row, 4);
  } finally { fs.unlinkSync(file); fs.rmdirSync(dir); }
});

test('campaign recipients detect international calling codes without an Indian fallback', () => {
  for (const value of ['+6581234567', '6581234567', '006581234567']) {
    assert.equal(parse(value).phone_number, '+6581234567');
    assert.equal(parse(value).country_code, '65');
  }
  assert.equal(parse('447391166058').country_code, '44');
  assert.equal(parse('+919372597458').phone_number, '+919372597458');
  assert.throws(() => parse('12345'));
});
