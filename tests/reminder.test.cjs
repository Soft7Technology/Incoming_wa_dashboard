require('ts-node/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveLocal, nextSend, templatePreview } = require('../src/app/utils/reminder');

test('resolves timezone and rejects invalid or past one-time dates', () => {
  assert.equal(resolveLocal('2026-10-01T09:30:00', 'Asia/Kolkata').toISOString(), '2026-10-01T04:00:00.000Z');
  assert.throws(() => resolveLocal('2026-02-30T09:00:00', 'UTC'), /Invalid calendar/);
  assert.throws(() => resolveLocal('2026-10-01T09:00:00', 'Invalid/Zone'));
  assert.throws(() => nextSend('2026-01-01T09:00:00', 'UTC', 'once', new Date('2026-01-02Z')), /future/);
});
test('DST gaps reject and folds choose the earlier instant', () => {
  assert.throws(() => resolveLocal('2026-03-08T02:30:00', 'America/New_York'), /does not exist/);
  assert.equal(resolveLocal('2026-11-01T01:30:00', 'America/New_York').toISOString(), '2026-11-01T05:30:00.000Z');
});
test('yearly preserves wall time, skips non-leap years, and advances strictly', () => {
  assert.equal(
    nextSend('2024-02-29T09:00:00', 'Asia/Kolkata', 'yearly', new Date('2026-01-01Z')).toISOString(),
    '2028-02-29T03:30:00.000Z',
  );
  assert.equal(
    nextSend('2025-07-01T09:00:00', 'America/New_York', 'yearly', new Date('2026-07-01T13:00:00Z')).toISOString(),
    '2027-07-01T13:00:00.000Z',
  );
});
test('preview renders named and positional variables without recursively substituting values', () => {
  const t = {
    name: 'hello',
    language: 'en',
    components: [
      { type: 'HEADER', format: 'TEXT', text: 'Hi {{1}}' },
      { type: 'BODY', text: 'Welcome {{name}} {{name}}' },
    ],
  };
  const out = templatePreview(t, { 'header.1': 'Lead', 'body.name': 'A $& {{other}}' });
  assert.equal(out.preview[1].text, 'Welcome A $& {{other}} A $& {{other}}');
  assert.equal(out.template.components[1].parameters[0].parameter_name, 'name');
  assert.deepEqual(out.required_variables, ['header.1', 'body.name']);
  assert.throws(() => templatePreview(t, { 'header.1': 'Lead' }), /body.name/);
  assert.throws(() => templatePreview(t, { 'header.1': 'Lead', 'body.name': 'A', extra: 'B' }), /Unknown/);
});
test('unsupported template components fail before saving', () => {
  assert.throws(() => templatePreview({ components: [{ type: 'HEADER', format: 'IMAGE' }] }), /text headers/);
  assert.throws(
    () =>
      templatePreview({
        components: [{ type: 'BUTTONS', buttons: [{ type: 'URL', url: 'https:\/\/example.com/{{1}}' }] }],
      }),
    /buttons/,
  );
});
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function serviceHarness() {
  const ids = Object.fromEntries(
    ['contact', 'phone', 'template', 'reminder'].map((key, i) => [key, `00000000-0000-4000-8000-00000000000${i}`]),
  );
  const rows = {
    contacts: [
      {
        id: ids.contact,
        user_id: 'owner',
        company_id: 'company',
        phone_number_id: ids.phone,
        assigned_to: ['member'],
        name: 'Lead',
        country_code: '91',
        phone_number: '9876543210',
      },
    ],
    phone_numbers: [
      {
        id: ids.phone,
        user_id: 'owner',
        company_id: 'company',
        waba_id: 'waba',
        status: 'active',
        display_phone_number: '+919999999999',
      },
    ],
    templates: [
      {
        id: ids.template,
        company_id: 'company',
        waba_id: 'waba',
        status: 'APPROVED',
        name: 'greeting',
        language: 'en',
        components: [{ type: 'BODY', text: 'Hi {{name}}' }],
      },
    ],
    reminders: [
      {
        id: ids.reminder,
        user_id: 'owner',
        company_id: 'company',
        contact_id: ids.contact,
        status: 'upcoming',
        timezone: 'UTC',
        next_send_at: new Date('2030-01-01Z'),
      },
    ],
  };
  const field = (key) => key.split('.').pop();
  function db(table) {
    const predicates = [];
    let mode = 'read',
      change,
      first = false;
    const q = {
      where(key, value) {
        predicates.push(
          typeof key === 'object'
            ? (row) => Object.entries(key).every(([k, v]) => row[field(k)] === v)
            : (row) => row[field(key)] === value,
        );
        return q;
      },
      whereNull(key) {
        predicates.push((row) => row[key] == null);
        return q;
      },
      whereRaw(sql, values) {
        predicates.push((row) => row.assigned_to?.includes(values[0]));
        return q;
      },
      whereIn(key, sub) {
        predicates.push((row) => sub.rows().some((x) => x.id === row[key]));
        return q;
      },
      select() {
        return q;
      },
      forUpdate() {
        return q;
      },
      returning() {
        return q;
      },
      first() {
        first = true;
        return q;
      },
      insert(values) {
        mode = 'insert';
        change = values;
        return q;
      },
      update(values) {
        mode = 'update';
        change = values;
        return q;
      },
      rows() {
        return (rows[table] || []).filter((row) => predicates.every((p) => p(row)));
      },
      then(resolve, reject) {
        return Promise.resolve()
          .then(() => {
            let result = q.rows();
            if (mode === 'insert') {
              result = (Array.isArray(change) ? change : [change]).map((value) => ({
                id: require('uuid').v4(),
                status: 'upcoming',
                ...value,
              }));
              (rows[table] ??= []).push(...result);
            }
            if (mode === 'update') result.forEach((row) => Object.assign(row, change));
            return first ? result[0] : result;
          })
          .then(resolve, reject);
      },
    };
    return q;
  }
  db.transaction = (fn) => fn(db);
  class HttpError extends Error {
    constructor({ message }) {
      super(message);
    }
  }
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync('src/app/services/reminder.service.ts', 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    }).outputText,
    {
      exports,
      Date,
      require: (id) =>
        ({
          '../models/reminder.model': loadReminderModel(db),
          '@surefy/exceptions/HTTP400Error': HttpError,
          '@surefy/exceptions/HTTP404Error': HttpError,
          uuid: require('uuid'),
          '../models/phoneNumber.model': {
            findByPhoneNumberId: async (id) => rows.phone_numbers.find((p) => p.id === id),
          },
          '../utils/importPhone': require('../src/app/utils/importPhone'),
          '../utils/reminder': require('../src/app/utils/reminder'),
        })[id],
    },
  );
  return {
    service: exports.default,
    rows,
    ids,
    scope: { companyId: 'company', ownerId: 'owner', actorId: 'owner' },
    body: {
      name: 'Follow up',
      contact_id: ids.contact,
      phone_number_id: ids.phone,
      template_id: ids.template,
      frequency: 'once',
      local_datetime: '2030-01-01T09:00:00',
      timezone: 'Asia/Kolkata',
      variables: { 'body.name': 'Lead' },
    },
  };
}
test('preview returns recipient and sender, enforces ownership and member assignment', async () => {
  const h = serviceHarness();
  const p = await h.service.preview(h.scope, h.body);
  assert.equal(p.recipient.whatsapp_number, '919876543210');
  assert.equal(p.sending_number.whatsapp_number, '+919999999999');
  assert.equal(p.next_send_at.toISOString(), '2030-01-01T03:30:00.000Z');
  await assert.rejects(h.service.preview({ ...h.scope, companyId: 'foreign' }, h.body), /not found/);
  await assert.rejects(h.service.preview({ ...h.scope, actorId: 'unassigned' }, h.body), /not found/);
  await h.service.preview({ ...h.scope, actorId: 'member' }, h.body);
});
test('save rejects opt-out, unapproved templates and mismatched sending number', async () => {
  const h = serviceHarness();
  h.rows.contacts[0].is_opted_out = true;
  await assert.rejects(h.service.create(h.scope, h.body), /opted out/);
  h.rows.contacts[0].is_opted_out = false;
  h.rows.templates[0].status = 'PAUSED';
  await assert.rejects(h.service.create(h.scope, h.body), /approved/);
  h.rows.templates[0].status = 'APPROVED';
  h.rows.contacts[0].phone_number_id = 'different';
  await assert.rejects(h.service.create(h.scope, h.body), /selected sending number/);
  assert.equal(h.rows.reminders.length, 1);
});
test('pause/cancel preserve records; sending is immutable; foreign accounts cannot act', async () => {
  const h = serviceHarness();
  await h.service.action(h.scope, h.ids.reminder, 'pause');
  assert.equal(h.rows.reminders[0].status, 'paused');
  await h.service.action(h.scope, h.ids.reminder, 'cancel');
  assert.equal(h.rows.reminders[0].status, 'cancelled');
  assert.equal(h.rows.reminders[0].next_send_at, null);
  await assert.rejects(h.service.action(h.scope, h.ids.reminder, 'resume'), /not allowed/);
  h.rows.reminders[0].status = 'sending';
  await assert.rejects(h.service.action(h.scope, h.ids.reminder, 'cancel'), /started sending/);
  await assert.rejects(h.service.update(h.scope, h.ids.reminder, h.body), /Only upcoming/);
  await assert.rejects(h.service.action({ ...h.scope, companyId: 'foreign' }, h.ids.reminder, 'cancel'), /not found/);
});
function schedulerHarness({ frequency = 'once', blocked = false, sendError = false, stale = false } = {}) {
  const row = {
    id: 'r',
    user_id: 'owner',
    company_id: 'company',
    phone_number_id: 'p',
    name: 'Follow up',
    frequency,
    timezone: 'UTC',
    local_datetime: '2020-01-01T09:00:00',
    next_send_at: new Date('2020-01-01Z'),
    status: stale ? 'sending' : 'upcoming',
    updated_at: new Date('2020-01-01Z'),
  };
  const rows = {
    reminders: [row],
    reminder_attempts: stale ? [{ id: 'old', reminder_id: 'r', status: 'sending' }] : [],
    reminder_delivery_events: [],
  };
  let sends = 0;
  function db(table) {
    const filters = [];
    let first = false,
      mode = 'read',
      change;
    const q = {
      where(key, op, value) {
        if (typeof key === 'object') filters.push((row) => Object.entries(key).every(([k, v]) => row[k] === v));
        else filters.push((row) => (op === '<' ? row[key] < value : op === '<=' ? row[key] <= value : row[key] === op));
        return q;
      },
      orderBy() {
        return q;
      },
      forUpdate() {
        return q;
      },
      skipLocked() {
        return q;
      },
      first() {
        first = true;
        return q;
      },
      insert(value) {
        mode = 'insert';
        change = value;
        return q;
      },
      update(value) {
        mode = 'update';
        change = value;
        return q;
      },
      then(resolve, reject) {
        return Promise.resolve()
          .then(() => {
            let results = rows[table].filter((row) => filters.every((f) => f(row)));
            if (mode === 'insert') {
              rows[table].push({ ...change });
              results = [change];
            }
            if (mode === 'update') results.forEach((row) => Object.assign(row, change));
            return first ? results[0] : results;
          })
          .then(resolve, reject);
      },
      catch(fn) {
        return q.then(undefined, fn);
      },
    };
    return q;
  }
  db.transaction = (fn) => fn(db);
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync('src/app/services/reminderScheduler.service.ts', 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    }).outputText,
    {
      exports,
      Date,
      console,
      setInterval,
      clearInterval,
      require: (id) =>
        ({
          'node-cron': {},
          uuid: require('uuid'),
          '../models/reminder.model': loadReminderModel(db),
          './reminder.service': {
            prepare: async () => ({
              phone: {},
              recipient: { phone_number: '9876543210', country_code: '91', whatsapp_number: '919876543210' },
              template: {},
              templateRecord: {},
              preview: [],
            }),
          },
          './message.service': {
            sendMessage: async () => {
              sends++;
              if (sendError) throw new Error('Meta rejected send');
              return { wamid: 'wamid.123' };
            },
          },
          './contactOptOut.service': { isBlocked: async () => blocked },
          '../utils/reminder': require('../src/app/utils/reminder'),
        })[id],
    },
  );
  return {
    scheduler: exports.default,
    rows,
    get sends() {
      return sends;
    },
  };
}
test('scheduler sends due one-time occurrence once and records its Meta ID', async () => {
  const h = schedulerHarness();
  await h.scheduler.tick();
  await h.scheduler.tick();
  assert.equal(h.sends, 1);
  assert.equal(h.rows.reminders[0].status, 'sent');
  assert.equal(h.rows.reminder_attempts[0].wamid, 'wamid.123');
  assert.equal(h.rows.reminder_attempts[0].scheduled_at.toISOString(), '2020-01-01T00:00:00.000Z');
});
test('yearly send failure is retained and advances to a future occurrence', async () => {
  const h = schedulerHarness({ frequency: 'yearly', sendError: true });
  await h.scheduler.tick();
  assert.equal(h.sends, 1);
  assert.equal(h.rows.reminders[0].status, 'upcoming');
  assert.ok(h.rows.reminders[0].next_send_at > new Date());
  assert.equal(h.rows.reminder_attempts[0].failure_reason, 'Meta rejected send');
});
test('opt-out prevents send and stale claims pause without retrying', async () => {
  const blocked = schedulerHarness({ blocked: true });
  await blocked.scheduler.tick();
  assert.equal(blocked.sends, 0);
  assert.equal(blocked.rows.reminders[0].status, 'failed');
  const stale = schedulerHarness({ stale: true });
  await stale.scheduler.tick();
  assert.equal(stale.sends, 0);
  assert.equal(stale.rows.reminders[0].status, 'paused');
  assert.equal(stale.rows.reminder_attempts[0].status, 'unknown');
});

function loadReminderModel(db) {
  class BaseModel {
    constructor(table) {
      this.tableName = table;
      this.db = db;
    }
    query() {
      return db(this.tableName);
    }
    async create(values) {
      const [row] = await this.query().insert(values).returning('*');
      return row;
    }
  }
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync('src/app/models/reminder.model.ts', 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    }).outputText,
    { exports, Date, require: (id) => ({ '@surefy/models/base.model': { BaseModel }, uuid: require('uuid') })[id] },
  );
  return exports.default;
}
const { resolveReminderMapping } = require('../src/app/utils/reminder');
test('campaign mappings resolve contact fields, custom attributes, literals and repeated placeholders', () => {
  const template = {
    name: 'birthday',
    language: 'en',
    components: [{ type: 'BODY', text: '{{1}} {{2}} {{3}} {{1}}' }],
  };
  const values = resolveReminderMapping(
    template,
    { name: 'Parth', attributes: { age: 0 } },
    { 1: 'fullName', 2: 'age', 3: 'Happy birthday' },
  );
  assert.deepEqual(values, { 'body.1': 'Parth', 'body.2': '0', 'body.3': 'Happy birthday' });
  assert.equal(templatePreview(template, values).preview[0].text, 'Parth 0 Happy birthday Parth');
  assert.throws(() => resolveReminderMapping(template, {}, { 1: 'fullName' }), /parameter_mapping/);
  assert.throws(() => resolveReminderMapping(template, {}, { 1: 'A', 2: 'B', 3: 'C', 4: 'extra' }), /Unknown/);
});
test('media headers produce Meta payloads and reject malformed URLs and surplus media', () => {
  for (const type of ['image', 'video', 'document']) {
    const template = {
      name: 'media',
      language: 'en',
      components: [
        { type: 'HEADER', format: type.toUpperCase() },
        { type: 'BODY', text: 'Hi {{1}}' },
      ],
    };
    const result = templatePreview(template, { 'body.1': 'Parth' }, [{ type, url: 'https://example.com/media' }]);
    assert.equal(result.template.components[0].parameters[0][type].link, 'https://example.com/media');
    assert.equal(result.preview[0].media.type, type);
    assert.equal(
      templatePreview(template, { 'body.1': 'Parth' }, [{ type, media_id: '123' }]).template.components[0]
        .parameters[0][type].id,
      '123',
    );
    assert.throws(
      () => templatePreview(template, { 'body.1': 'Parth' }, [{ type, url: '[url](https://example.com/media)' }]),
      /HTTPS/,
    );
    assert.throws(
      () => templatePreview(template, { 'body.1': 'Parth' }, [{ type, url: 'http://example.com/media' }]),
      /HTTPS/,
    );
    assert.throws(
      () =>
        templatePreview(template, { 'body.1': 'Parth' }, [
          { type, media_id: '1' },
          { type, media_id: '2' },
        ]),
      /exactly one/,
    );
  }
});
test('reminder preview resolves mappings against current contact and supports image templates', async () => {
  const h = serviceHarness();
  h.rows.templates[0].components = [
    { type: 'HEADER', format: 'IMAGE' },
    { type: 'BODY', text: 'Happy birthday {{1}}' },
  ];
  const body = {
    ...h.body,
    variables: undefined,
    parameter_mapping: { 1: 'fullName' },
    media_uploads: [{ type: 'image', url: 'https://example.com/birthday.jpg' }],
  };
  assert.equal((await h.service.preview(h.scope, body)).preview[1].text, 'Happy birthday Lead');
  h.rows.contacts[0].name = 'Updated';
  assert.equal((await h.service.prepare(h.scope, body, false)).preview[1].text, 'Happy birthday Updated');
  const created = await h.service.create(h.scope, body);
  assert.equal(created.parameter_mapping['1'], 'fullName');
  assert.equal(created.media_uploads[0].type, 'image');
  await assert.rejects(h.service.preview(h.scope, { ...body, variables: { 'body.1': 'Both' } }), /either/);
  const picker = await h.service.templates(h.scope, h.ids.phone);
  assert.equal(picker[0].supported, true);
  assert.equal(picker[0].required_media_type, 'image');
});

test('multiple contacts create independent reminders with one shared occurrence', async () => {
  const h = serviceHarness();
  const secondId = '00000000-0000-4000-8000-000000000099';
  h.rows.contacts.push({ ...h.rows.contacts[0], id: secondId, name: 'Second lead' });
  const { contact_id, variables, ...input } = h.body;
  const result = await h.service.createBulk(h.scope, {
    ...input,
    contact_ids: [contact_id, secondId],
    parameter_mapping: { name: 'fullName' },
  });
  assert.equal(result.created_count, 2);
  assert.notEqual(result.items[0].id, result.items[1].id);
  assert.equal(+result.items[0].next_send_at, +result.items[1].next_send_at);
  assert.deepEqual(
    Array.from(result.items, (row) => row.contact_id),
    [contact_id, secondId],
  );
  assert.equal(JSON.parse(result.items[0].parameter_mapping).name, 'fullName');
});
test('invalid or inaccessible bulk contacts leave no partial reminders', async () => {
  const h = serviceHarness();
  const { contact_id, ...input } = h.body;
  for (const ids of [[], [contact_id, contact_id], ['bad'], Array(101).fill(contact_id)]) {
    await assert.rejects(h.service.createBulk(h.scope, { ...input, contact_ids: ids }));
  }
  await assert.rejects(h.service.createBulk(h.scope, { ...h.body, contact_ids: [contact_id] }), /instead/);
  await assert.rejects(
    h.service.createBulk(h.scope, { ...input, contact_ids: [contact_id, '00000000-0000-4000-8000-000000000099'] }),
    /not found/,
  );
  assert.equal(h.rows.reminders.length, 1);
});

