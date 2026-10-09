require('ts-node/register');
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {parseImportedPhone: parse} = require('../src/app/utils/importPhone');
test('detects international codes from the sample without adding default 91',()=>{
  for (const [number,code] of [['32470205982','32'],['33635295378','33'],['5521994774209','55'],['447391166058','44'],['573228398973','57']]) assert.equal(parse('+' + number,'91').country_code,code);
});
test('national Indian number uses fallback',()=>assert.equal(parse('9687730639','91').phone_number,'9687730639'));
test('explicit international prefix needs no default',()=>assert.equal(parse('0032470205982').country_code,'32'));
test('invalid number is rejected',()=>assert.throws(()=>parse('abc','91')));
test('ignores invisible directional marks copied with a number',()=>{
  assert.equal(parse('\u202a+56971381606\u202c','91').country_code,'56');
  assert.equal(parse('8141322322\u202c','91').phone_number,'8141322322');
});

test('expands scientific text without changing digits and supports numeric Excel cells', () => {
  for (const value of ['9.19372597458E+11', '9.1937259745800e11', '9193725974580E-1', 919372597458]) {
    assert.equal(parse(value, '91').phone_number, '9372597458');
  }
  assert.equal(parse('9.687730639e9', '91').phone_number, '9687730639');
  assert.equal(parse('+3.2470205982E10', '91').phone_number, '470205982');
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
  for (const value of ['+6581234567', '006581234567']) {
    assert.equal(parse(value).phone_number, '81234567');
    assert.equal(parse(value).country_code, '65');
  }
  assert.equal(parse('+447391166058').country_code, '44');
  assert.equal(parse('+919372597458').phone_number, '9372597458');
  assert.throws(() => parse('12345'));
});

test('row country codes support numeric, plus, 00 and ISO forms', () => {
  for (const code of ['65', '+65', '0065', 'SG', 'sg']) {
    assert.equal(parse('92956294', code, true).phone_number, '92956294');
  }
  assert.equal(parse('7579380000', 'IN', true).phone_number, '7579380000');
  assert.equal(parse('07391166058', 'GB', true).phone_number, '7391166058');
  assert.throws(() => parse('+32470205982', '91', true), /conflicts/);
  assert.equal(parse('6592956294', '65', true).phone_number, '92956294');
});
test('mixed-country workbook detects each row and never applies 91 to every contact', async () => {
  const XLSX = require('xlsx'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const parser = require('../src/app/services/xlsxParser.service').default;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-phone-'));
  const file = path.join(dir, 'contacts.xlsx');
  try {
    const sheet = XLSX.utils.aoa_to_sheet([
      ['phone', 'CountryCode'], ['92956294', 'SG'], ['7579380000', 91],
      ['07391166058', '+44'], ['+32470205982', '32'], ['+33635295378', ''],
      ['6.592956294E9', '65'], ['92956294', '  '],
    ]);
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, 'Contacts'); XLSX.writeFile(book, file);
    const result = await parser.parseContactsFromFile(file, '91');
    assert.deepEqual(result.contacts.map(c => c.country_code), ['65', '91', '44', '32', '33', '65', null]);
    assert.equal(result.invalid, 0);
    assert.equal(result.needs_country, 1);
    assert.equal(result.contacts[0].phone_number, '+6592956294');
  } finally { fs.unlinkSync(file); fs.rmdirSync(dir); }
});

test('Indian local numbers do not become Myanmar, Maldives, Lebanon or Bhutan numbers', () => {
  for (const number of ['9522007000', '9607155555', '9617855555', '9752665171', '9598065229']) {
    const result = parse(number, '91', false, true);
    assert.equal(result.phone_number, number);
    assert.equal(result.country_code, '91');
    assert.throws(() => parse(number, '', false, true), /Country code is required/);
  }
  assert.equal(parse('+447831774016', '91', false, true).country_code, '44');
  assert.equal(parse('92956294', '65', true, true).phone_number, '92956294');
});


test('import saves unresolved numbers without assuming India', async () => {
  const XLSX = require('xlsx'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const parser = require('../src/app/services/xlsxParser.service').default;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-clarification-'));
  const file = path.join(dir, 'contacts.xlsx');
  try {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
      ['phone', 'country_code'], ['9372597458', ''], ['81234567', '65'], ['+6581234567', '91'],
    ]), 'Contacts');
    XLSX.writeFile(book, file);
    const result = await parser.parseContactsFromFile(file, '');
    assert.equal(result.valid, 2);
    assert.equal(result.invalid, 0);
    assert.equal(result.needs_country, 1);
    assert.deepEqual(result.errors, []);
    assert.equal(result.contacts[0].is_valid, false);
    assert.deepEqual(result.contacts.map(c => [c.country_code, c.phone_number]), [[null, '+9372597458'], ['65', '+6581234567'], ['65', '+6581234567']]);
  } finally { fs.unlinkSync(file); fs.rmdirSync(dir); }
});
const { parseSpreadsheetPhone, toContactPhone } = require('../src/app/utils/importPhone');
test('imports preserve international identities across conflicting optional country hints', () => {
  for (const [input, expected, code] of [
    ['19169435965', '+19169435965', '1'], ['447879543645', '+447879543645', '44'],
    ['491783433573', '+491783433573', '49'], ['+6581234567', '+6581234567', '65']
  ]) {
    for (const hint of ['', '91', 'INVALID']) {
      assert.deepEqual(parseSpreadsheetPhone(input, hint), {phone_number: expected.slice(1 + code.length), country_code: code});
    }
  }
  assert.deepEqual(parseSpreadsheetPhone('81234567', '65'), {phone_number:'81234567', country_code:'65'});
  assert.throws(() => parseSpreadsheetPhone('9372597458'), /Needs country/);
  assert.throws(() => parseSpreadsheetPhone('1234567890123456'), /length/);
  assert.equal(toContactPhone(parse('39066982','39')).phone_number, '+39066982');
});
test('CSV with mixed international numbers needs no country column', async () => {
  const fs=require('node:fs'), os=require('node:os'), path=require('node:path');
  const parser=require('../src/app/services/xlsxParser.service').default;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'international-csv-'));
  const file=path.join(dir,'contacts.csv');
  try {
    fs.writeFileSync(file, 'Name,Phone number\nUS,19169435965\nUK,447879543645\nGermany,491783433573\n');
    const result=await parser.parseContactsFromFile(file, '', 'Phone number', 'Name');
    assert.equal(result.valid,3); assert.equal(result.invalid,0);
    assert.deepEqual(result.contacts.map(c=>c.phone_number), ['+19169435965','+447879543645','+491783433573']);
  } finally {fs.unlinkSync(file);fs.rmdirSync(dir);}
});
test('validated preview counts all rows and preserves existing sample fields', async () => {
  const fs=require('node:fs'), os=require('node:os'), path=require('node:path');
  const parser=require('../src/app/services/xlsxParser.service').default;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'validated-preview-'));
  const file=path.join(dir,'contacts.csv');
  try {
    fs.writeFileSync(file,'Name,Phone number\nUS,19169435965\nUK,447879543645\nSG,+6581234567\nUS2,19169435965\nUK2,447879543645\nBad,abc\n');
    const result=await parser.getValidatedPreview(file,{name_column:'Name'});
    assert.equal(result.total_rows,6);
    assert.equal(result.preview.length,5);
    assert.equal(result.valid_count,5);
    assert.equal(result.invalid_count,1);
    assert.equal(result.errors[0].row,7);
    assert.equal(result.errors[0].phone_number,'abc');
    assert.equal(result.normalized_preview[0].phone_number,'+19169435965');
    assert.equal(result.selected_phone_column,'Phone number');
    await assert.rejects(parser.getValidatedPreview(file,{phone_column:'missing'}),/was not found/);
    await assert.rejects(parser.getValidatedPreview(file,{phone_column:[]}),/must be a string/);
    fs.writeFileSync(file,'Name,Number\nSG,81234567\nBad,abc\n');
    const hinted=await parser.getValidatedPreview(file,{phone_column:'Number',country_code:'65'});
    assert.equal(hinted.valid_count,1); assert.equal(hinted.invalid_count,1);
    const imported=await parser.parseContactsFromFile(file,'65','Number');
    assert.equal(hinted.valid_count,imported.valid);
    assert.deepEqual(hinted.errors,imported.errors);
  } finally {fs.unlinkSync(file);fs.rmdirSync(dir);}
});
test('Needs country differs from invalid and selected countries resolve local numbers', async () => {
  assert.throws(() => parseSpreadsheetPhone('9372597458'), error => error.code === 'NEEDS_COUNTRY');
  assert.deepEqual(parseSpreadsheetPhone('9372597458', 'IN'), {phone_number:'9372597458',country_code:'91'});
  assert.deepEqual(parseSpreadsheetPhone('7879543645', 'GB'), {phone_number:'7879543645',country_code:'44'});
  for (const value of ['+447879543645','447879543645']) {
    assert.deepEqual(parseSpreadsheetPhone(value), {phone_number:'7879543645',country_code:'44'});
  }
  assert.throws(() => parseSpreadsheetPhone('+1234'), error => error.code !== 'NEEDS_COUNTRY');
  assert.throws(() => parseSpreadsheetPhone('abc'), error => error.code !== 'NEEDS_COUNTRY');
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const parser=require('../src/app/services/xlsxParser.service').default;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'country-preview-')), file=path.join(dir,'contacts.csv');
  try {
    fs.writeFileSync(file,'phone\n+447879543645\n447879543645\n9372597458\nabc\n');
    const result=await parser.getValidatedPreview(file);
    assert.equal(result.total_rows,4);assert.equal(result.valid_count,2);
    assert.equal(result.invalid_count,1);assert.equal(result.needs_country_count,1);
    assert.equal(result.importable_count,3);
    assert.equal(result.needs_country[0].country_code,null);
    assert.equal(result.errors[0].status,'invalid');
  } finally {fs.unlinkSync(file);fs.rmdirSync(dir);}
});

const { parseStoredContactPhone } = require('../src/app/utils/importPhone');
test('storage preserves full numbers and retains unresolved numeric contacts', () => {
  for (const input of ['919372597458', '+919372597458']) {
    assert.deepEqual(parseStoredContactPhone(input), {phone_number:'+919372597458',country_code:'91',is_valid:true});
  }
  assert.deepEqual(parseStoredContactPhone('9372597458'), {phone_number:'+9372597458',country_code:null,is_valid:false});
  assert.deepEqual(parseStoredContactPhone('9372597458', '91'), {phone_number:'+919372597458',country_code:'91',is_valid:true});
  for (const input of ['abc', '12+34567', '1234567890123456', 1234567890123456]) assert.throws(() => parseStoredContactPhone(input));
});
