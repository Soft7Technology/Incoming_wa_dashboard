const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const exported = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/utils/campaignRecipients.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { exports: exported });

test('different contact IDs and formatting produce one recipient, preserving first template data', () => {
  const first = { id: 'a', phone_number: '+91 93725 97458', name: 'First' };
  const contacts = [first, { id: 'b', phone_number: '919372597458' },
    { id: 'c', phone_number: '+91-93725-97458' }, { id: 'd', phone_number: '+918888888888' }];
  const result = exported.uniqueCampaignRecipients(contacts);
  assert.equal(result.length, 2);
  assert.equal(result[0], first);
  assert.equal(result[1].id, 'd');
  assert.equal(contacts.length, 4);
});

test('deduplication is per campaign, excludes empty numbers and does not infer country codes', () => {
  const contacts = [{ phone_number: '+919372597458' }, { phone_number: '9372597458' }, { phone_number: ' + - ' }];
  assert.equal(exported.uniqueCampaignRecipients(contacts).length, 2);
  assert.equal(exported.uniqueCampaignRecipients(contacts).length, 2);
});
