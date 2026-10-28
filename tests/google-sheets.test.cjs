require('ts-node/register');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');
const XLSX = require('xlsx');
const { CustomError } = require('../library/surefy/src/exceptions/CustomError');
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'google-sheets-test-'));
after(() => {
  const resolved = path.resolve(runtime);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('google-sheets-test-'));
  fs.rmSync(resolved, { recursive: true, force: true });
});
const scope = { companyId: crypto.randomUUID(), ownerId: crypto.randomUUID(), userId: '' };
scope.userId = scope.ownerId;
const other = { ...scope, companyId: crypto.randomUUID() };
const phoneId = crypto.randomUUID(),
  snapshotId = crypto.randomUUID(),
  templateId = crypto.randomUUID();
Object.assign(process.env, {
  GOOGLE_CLIENT_ID: 'test-client',
  GOOGLE_CLIENT_SECRET: 'test-secret',
  GOOGLE_REDIRECT_URI: 'https://api.example.test/v1/integrations/google/callback',
  GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
});

function load(file, deps = {}) {
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    }).outputText,
    {
      exports,
      process,
      Buffer,
      URL,
      URLSearchParams,
      Date,
      console,
      __dirname: path.dirname(path.resolve(file)),
      __filename: path.resolve(file),
      require: (id) => (Object.hasOwn(deps, id) ? deps[id] : require(id)),
    },
  );
  return exports;
}
const utils = load('src/app/utils/googleSheets.ts', {
  '@surefy/exceptions/CustomError': { CustomError },
  './importPhone': require('../src/app/utils/importPhone'),
});
const serviceModule = load('src/app/services/googleSheets.service.ts', {
  '@surefy/database': () => {
    throw Error('Inject isolated test database');
  },
  '@surefy/middleware/upload.middleware': { UPLOADS_DIR: runtime },
  '@surefy/exceptions/CustomError': { CustomError },
  '../utils/googleSheets': utils,
  './googleSheetsClient.service': { GoogleSheetsClient: class {} },
});

// An isolated query fixture exercises account filters and the transaction hook;
// This fixture does not substitute for PostgreSQL locking/foreign-key validation.
function memoryDatabase(initial = {}) {
  let tables = structuredClone(initial),
    tail = Promise.resolve();
  const database = (table) => {
    const filters = [];
    let operation = 'read',
      data,
      first = false,
      fields,
      limit,
      merge,
      conflict;
    const query = {
      where(key, op, value) {
        if (typeof key === 'object') filters.push((row) => Object.entries(key).every(([k, v]) => row[k] === v));
        else if (arguments.length === 2) filters.push((row) => row[key] === op);
        else
          filters.push((row) =>
            op === '>' ? new Date(row[key]) > new Date(value) : new Date(row[key]) < new Date(value),
          );
        return query;
      },
      whereNull(key) {
        filters.push((row) => row[key] == null);
        return query;
      },
      first(...selected) {
        first = true;
        if (selected.length) fields = selected.flat();
        return query;
      },
      select(...selected) {
        fields = selected.flat();
        return query;
      },
      forUpdate() {
        return query;
      },
      orderBy() {
        return query;
      },
      limit(n) {
        limit = n;
        return query;
      },
      insert(value) {
        operation = 'insert';
        data = value;
        return query;
      },
      update(value) {
        operation = 'update';
        data = value;
        return query;
      },
      delete() {
        operation = 'delete';
        return query;
      },
      returning(...selected) {
        fields = selected.flat();
        return query;
      },
      onConflict(keys) {
        conflict = keys;
        return query;
      },
      merge(value) {
        merge = value;
        return query;
      },
      then(resolve, reject) {
        return Promise.resolve()
          .then(() => {
            const all = (tables[table] ||= []);
            let rows = all.filter((row) => filters.every((filter) => filter(row)));
            const decode = (value) =>
              Object.fromEntries(
                Object.entries(value).map(([k, v]) => [
                  k,
                  ['rows', 'headers', 'summary', 'source'].includes(k) && typeof v === 'string' ? JSON.parse(v) : v,
                ]),
              );
            if (operation === 'insert') {
              const existing = conflict && all.find((row) => conflict.every((k) => row[k] === data[k]));
              if (existing && merge) {
                Object.assign(existing, decode(merge));
                rows = [existing];
              } else {
                if (
                  table === 'google_sheet_campaign_requests' &&
                  all.some(
                    (row) =>
                      row.company_id === data.company_id &&
                      row.owner_id === data.owner_id &&
                      row.request_id === data.request_id,
                  )
                ) {
                  const error = Error('duplicate');
                  error.code = '23505';
                  throw error;
                }
                const created = {
                  id: crypto.randomUUID(),
                  created_at: new Date(),
                  updated_at: new Date(),
                  ...decode(data),
                };
                all.push(created);
                rows = [created];
              }
            } else if (operation === 'update') rows.forEach((row) => Object.assign(row, decode(data)));
            else if (operation === 'delete') tables[table] = all.filter((row) => !rows.includes(row));
            const result = rows
              .slice(0, limit)
              .map((row) =>
                !fields || fields.includes('*')
                  ? structuredClone(row)
                  : Object.fromEntries(fields.map((k) => [k, row[k]])),
              );
            return first ? result[0] : result;
          })
          .then(resolve, reject);
      },
    };
    return query;
  };
  database.transaction = (fn) => {
    const result = tail.then(async () => {
      const before = structuredClone(tables);
      try {
        return await fn(database);
      } catch (e) {
        tables = before;
        throw e;
      }
    });
    tail = result.catch(() => {});
    return result;
  };
  database.tables = () => tables;
  return database;
}
function fixture(extra = {}) {
  const phone = { id: phoneId, user_id: scope.ownerId, company_id: scope.companyId, waba_id: 'waba' };
  const database = memoryDatabase({
    users: [{ id: scope.ownerId, company_id: scope.companyId, status: 'active' }],
    companies: [{ id: scope.companyId, status: 'active' }],
    phone_numbers: [phone],
    templates: [{ id: templateId, company_id: scope.companyId, waba_id: 'waba', status: 'APPROVED' }],
    google_sheet_connections: [
      {
        id: 'connection',
        company_id: scope.companyId,
        owner_id: scope.ownerId,
        access_token_ciphertext: utils.encrypt('access-token', scope),
        refresh_token_ciphertext: utils.encrypt('refresh-token', scope),
        token_expires_at: new Date(Date.now() + 3600000),
      },
    ],
    ...extra,
  });
  const counts = { exchanges: 0, refreshes: 0, imports: 0, campaigns: 0 };
  const google = {
    async exchange() {
      counts.exchanges++;
      return { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 };
    },
    async refresh() {
      counts.refreshes++;
      return { access_token: 'refreshed-access', expires_in: 3600 };
    },
    async revoke() {},
    async metadata() {
      return { sheets: [{ properties: { sheetId: 0, title: "Guests' list", gridProperties: { columnCount: 26 } } }] };
    },
    async rows() {
      return [
        ['Mobile', 'Guest', 'Event'],
        ['9372597458', 'Alice', 'Launch'],
      ];
    },
  };
  const deps = {
    async queueImport(s, sender, file, name) {
      counts.imports++;
      const [job] = await database('import_jobs')
        .insert({
          user_id: s.ownerId,
          company_id: s.companyId,
          phone_number_id: sender,
          file_path: file,
          status: 'queued',
          list_name: name,
        })
        .returning('*');
      return job;
    },
    async importStatus(s, id) {
      return database('import_jobs').where({ id, user_id: s.ownerId, company_id: s.companyId }).first();
    },
    async createCampaign(s, data, committed) {
      return database.transaction(async (trx) => {
        counts.campaigns++;
        const [created] = await trx('campaigns')
          .insert({ user_id: s.ownerId, company_id: s.companyId, ...data })
          .returning('*');
        await committed(created, trx);
        return created;
      });
    },
  };
  const service = new serviceModule.GoogleSheetsService(database, google, deps);
  return { database, google, service, counts, deps };
}
const previewInput = {
  spreadsheet_id: 'spreadsheet-id-123',
  sheet_id: 0,
  phone_number_id: phoneId,
  country_code: '91',
  mapping: { phone: 'Mobile', name: 'Guest' },
};
const campaignInput = () => ({
  request_id: crypto.randomUUID(),
  snapshot_id: snapshotId,
  campaign: { name: 'Invitations', template_id: templateId },
});
function completedFixture() {
  const jobId = crypto.randomUUID();
  return fixture({
    google_sheet_snapshots: [
      {
        id: snapshotId,
        company_id: scope.companyId,
        owner_id: scope.ownerId,
        phone_number_id: phoneId,
        import_job_id: jobId,
      },
    ],
    import_jobs: [
      {
        id: jobId,
        user_id: scope.ownerId,
        company_id: scope.companyId,
        phone_number_id: phoneId,
        status: 'completed',
        failed_rows: 0,
        list_id: crypto.randomUUID(),
      },
    ],
  });
}

test('saved tokens are encrypted, tamper-resistant and bound to their account', () => {
  const encrypted = utils.encrypt('secret-token', scope);
  assert.equal(utils.decrypt(encrypted, scope), 'secret-token');
  assert.ok(!encrypted.includes('secret-token'));
  assert.throws(() => utils.decrypt(encrypted, other), /cannot be decrypted/);
  assert.throws(() => utils.decrypt(encrypted.slice(0, -4) + 'AAAA', scope), /cannot be decrypted/);
});
test('column mapping preserves attributes, normalizes and deduplicates international identities', () => {
  const parsed = utils.parseSheet(
    [
      ['Mobile', 'Guest', 'Event'],
      ['9372597458', 'Alice', 'Launch'],
      ['+919372597458', 'Duplicate', 'Launch'],
      ['bad', 'Invalid', 'Launch'],
      ['', '', ''],
    ],
    previewInput.mapping,
    '91',
  );
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0][0], '+919372597458');
  assert.equal(parsed.rows[0][4], 'Launch');
  assert.equal(parsed.summary.duplicate_rows, 1);
  assert.equal(parsed.summary.invalid_rows, 1);
});
test('ambiguous headers, prototype keys and invalid mappings are rejected', () => {
  for (const headers of [
    ['Mobile', 'mobile'],
    ['Mobile', '__proto__'],
    ['Mobile', ''],
  ]) {
    assert.throws(() => utils.parseSheet([headers, ['9372597458']], { phone: 'Mobile' }, '91'), /headers/);
  }
  assert.throws(() => utils.parseSheet([['Mobile'], ['9372597458']], { phone: 'Missing' }, '91'), /mappings/);
  assert.throws(() => utils.spreadsheetId('https://evil.test/sheet'), /spreadsheet_id/);
});
test('OAuth uses PKCE and a one-time state bound to the initiating browser', async () => {
  const f = fixture(),
    started = await f.service.start(scope);
  const url = new URL(started.authorization_url),
    state = url.searchParams.get('state');
  assert.equal(url.searchParams.get('scope'), utils.googleFileScope);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  await assert.rejects(f.service.callback(state, utils.random(), 'code', false), /expired or was already used/);
  assert.equal(f.counts.exchanges, 0);
  assert.equal((await f.service.callback(state, started.browser, 'code', false)).connected, true);
  await assert.rejects(f.service.callback(state, started.browser, 'code', false), /expired or was already used/);
  assert.equal(f.counts.exchanges, 1);
  assert.ok(!JSON.stringify(await f.service.connection(scope)).includes('new-refresh'));
});
test('expired and denied OAuth requests cannot create a connection', async () => {
  const f = fixture(),
    started = await f.service.start(scope),
    state = new URL(started.authorization_url).searchParams.get('state');
  assert.equal((await f.service.callback(state, started.browser, undefined, true)).connected, false);
  assert.equal(f.counts.exchanges, 0);
  const second = await f.service.start(scope);
  await f.database('google_sheet_oauth_sessions').update({ expires_at: new Date(0) });
  await assert.rejects(
    f.service.callback(new URL(second.authorization_url).searchParams.get('state'), second.browser, 'code', false),
    /expired/,
  );
});
test('parallel operations refresh an expired connection once', async () => {
  const f = fixture();
  await f.database('google_sheet_connections').update({ token_expires_at: new Date(0) });
  const results = await Promise.all([f.service.pickerToken(scope), f.service.pickerToken(scope)]);
  assert.equal(f.counts.refreshes, 1);
  assert.equal(results[0].access_token, 'refreshed-access');
  await assert.rejects(f.service.pickerToken(other), /Connect Google/);
});
test('preview and import are account-scoped; imports use saved rows and are repeatable without duplicate jobs', async () => {
  const f = fixture(),
    preview = await f.service.preview(scope, previewInput);
  await assert.rejects(f.service.importSnapshot(other, preview.snapshot_id, { list_name: 'Other' }), /not found/);
  f.google.rows = async () => [
    ['Mobile', 'Guest', 'Event'],
    ['+6581234567', 'Changed', 'Other'],
  ];
  const first = await f.service.importSnapshot(scope, preview.snapshot_id, { list_name: 'Guests' });
  const second = await f.service.importSnapshot(scope, preview.snapshot_id, { list_name: 'Guests' });
  assert.equal(first.import_job_id, second.import_job_id);
  assert.equal(f.counts.imports, 1);
  const job = f.database.tables().import_jobs[0],
    workbook = XLSX.readFile(job.file_path);
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets.Contacts);
  assert.equal(rows[0].phone_number, '+919372597458');
  assert.equal(rows[0].Event, 'Launch');
});
test('expired previews and sender IDs from another account cannot be imported', async () => {
  const f = fixture();
  await assert.rejects(f.service.preview(other, previewInput), /phone number not found/);
  const preview = await f.service.preview(scope, previewInput);
  await f.database('google_sheet_snapshots').update({ expires_at: new Date(0) });
  await assert.rejects(f.service.importSnapshot(scope, preview.snapshot_id, { list_name: 'Expired' }), /expired/);
  assert.equal(f.counts.imports, 0);
});
test('campaign creation requires a completed import and an approved template in the sender WABA', async () => {
  const f = completedFixture();
  await f.database('import_jobs').update({ status: 'processing' });
  await assert.rejects(f.service.createCampaign(scope, campaignInput()), /Wait for/);
  await f.database('import_jobs').update({ status: 'completed' });
  await f.database('templates').update({ waba_id: 'other-waba' });
  await assert.rejects(f.service.createCampaign(scope, campaignInput()), /Approved template not found/);
  assert.equal(f.counts.campaigns, 0);
});
test('campaign request IDs prevent duplicate creation and cannot be reused with changed payloads', async () => {
  const f = completedFixture(),
    input = campaignInput();
  const first = await f.service.createCampaign(scope, input),
    second = await f.service.createCampaign(scope, input);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(first.campaign.id, second.campaign.id);
  assert.equal(f.counts.campaigns, 1);
  assert.equal(first.campaign.phone_number_id, phoneId);
  assert.equal(first.campaign.contact_filters.list_ids.length, 1);
  assert.equal(first.campaign.send_immediately, undefined);
  await assert.rejects(
    f.service.createCampaign(scope, { ...input, campaign: { ...input.campaign, name: 'Changed' } }),
    /already used/,
  );
  await assert.rejects(f.service.createCampaign(other, input), /snapshot not found/);
});
test('partial imports require explicit acceptance and recipient overrides are rejected', async () => {
  const f = completedFixture(),
    input = campaignInput();
  await f.database('import_jobs').update({ failed_rows: 1 });
  await assert.rejects(f.service.createCampaign(scope, input), /accept_partial_import/);
  await assert.rejects(
    f.service.createCampaign(scope, { ...input, campaign: { ...input.campaign, contact_filters: {} } }),
    /Unsupported/,
  );
  const created = await f.service.createCampaign(scope, { ...input, accept_partial_import: true });
  assert.equal(created.replayed, false);
});
test('bulk campaigns report individual failures and do not recreate successful requests on retry', async () => {
  const f = completedFixture(),
    input = { campaigns: [campaignInput(), { request_id: 'bad' }] };
  const result = await f.service.bulkCampaigns(scope, input);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
  assert.equal((await f.service.bulkCampaigns(scope, input)).results[0].replayed, true);
  assert.equal(f.counts.campaigns, 1);
});
test('upstream errors do not expose OAuth tokens, secrets or raw Google response bodies', async () => {
  const client = load('src/app/services/googleSheetsClient.service.ts', {
    axios: {
      request: async () => {
        const error = Error('access-token client-secret');
        error.response = { status: 400, data: { token: 'raw-token' } };
        throw error;
      },
    },
    '../utils/googleSheets': utils,
  });
  await assert.rejects(
    new client.GoogleSheetsClient().refresh('refresh-token'),
    (error) => error instanceof CustomError && !/token|secret/.test(error.message),
  );
});
test('account members cannot manage the owner Google connection', async () => {
  const f = fixture();
  await assert.rejects(f.service.start({ ...scope, userId: crypto.randomUUID() }), /Only the account owner/);
  await assert.rejects(f.service.disconnect({ ...scope, userId: crypto.randomUUID() }), /Only the account owner/);
});

test('HTTP endpoints protect credentials, bind the callback cookie and return partial bulk results', async () => {
  const express = require('express'),
    f = completedFixture();
  const controller = load('src/app/http/controllers/googleSheets.controller.ts', {
    '@surefy/utils/Controller': require('../library/surefy/src/utils/Controller'),
    '../../services/googleSheets.service': f.service,
    '../../utils/googleSheets': utils,
  });
  const route = load('src/routes/googleSheets.route.ts', {
    express,
    '@surefy/middleware/jwtAuth.middleware': {
      requireRole: (role) => (req, res, next) => (req.userRole === role ? next() : res.sendStatus(403)),
    },
    '../app/http/middleware/accountScope': { accountScope: (_req, _res, next) => next() },
    '../app/http/controllers/googleSheets.controller': controller,
  }).default;
  const publicRoute = load('src/routes/googleSheetsPublic.route.ts', {
    express,
    '../app/http/controllers/googleSheets.controller': controller,
  }).default;
  const app = express();
  app.use(express.json());
  app.use(
    '/v1/admin/google-sheets',
    (req, res, next) => {
      if (!req.headers.authorization) return res.sendStatus(401);
      Object.assign(req, scope, { userRole: req.headers.authorization === 'Bearer member' ? 'member' : 'user' });
      next();
    },
    route,
  );
  app.use('/v1/integrations/google', publicRoute);
  app.use((error, _req, res, _next) =>
    res.status(error.statusCode || 500).json({ success: false, message: error.message }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
  try {
    const page = await fetch(base + '/v1/integrations/google/test');
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin-allow-popups');
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const html = await page.text();
    assert.match(html, /Connect Google Sheets/);
    assert.ok(!html.includes(process.env.GOOGLE_CLIENT_SECRET));
    const script = await fetch(base + '/v1/integrations/google/test.js');
    assert.equal(script.status, 200);
    assert.ok(!(await script.text()).includes('localStorage'));
    const publicConfig = await fetch(base + '/v1/integrations/google/test-config');
    assert.equal(publicConfig.status, 200);
    const publicData = await publicConfig.json();
    assert.equal(publicData.data.ready, true);
    assert.ok(!JSON.stringify(publicData).includes(process.env.GOOGLE_CLIENT_SECRET));
    assert.equal(publicData.data.client_secret, undefined);
    assert.equal((await fetch(base + '/v1/admin/google-sheets/setup')).status, 401);
    assert.equal(
      (await fetch(base + '/v1/admin/google-sheets/setup', { headers: { Authorization: 'Bearer member' } })).status,
      403,
    );
    const start = await fetch(base + '/v1/admin/google-sheets/oauth/start', { method: 'POST', headers });
    assert.equal(start.status, 200);
    assert.equal(start.headers.get('cache-control'), 'no-store');
    assert.match(start.headers.get('set-cookie'), /HttpOnly/);
    const cookie = start.headers.get('set-cookie').split(';')[0];
    const state = new URL((await start.json()).data.authorization_url).searchParams.get('state');
    const url = base + '/v1/integrations/google/callback?state=' + state + '&code=test-code';
    assert.equal((await fetch(url)).status, 400);
    const callback = await fetch(url, { headers: { Cookie: cookie } });
    assert.equal(callback.status, 200);
    assert.equal(callback.headers.get('referrer-policy'), 'no-referrer');
    assert.equal((await callback.json()).data.connected, true);
    const created = await fetch(base + '/v1/admin/google-sheets/campaigns/bulk', {
      method: 'POST',
      headers,
      body: JSON.stringify({ campaigns: [campaignInput(), { request_id: 'invalid' }] }),
    });
    assert.equal(created.status, 207);
    assert.equal((await created.json()).data.failed, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('snapshot import retries recover an already queued job after a lost snapshot update', async () => {
  const f = fixture(),
    preview = await f.service.preview(scope, previewInput);
  const file = path.join(runtime, '.google-sheets', preview.snapshot_id + '.xlsx');
  const [job] = await f
    .database('import_jobs')
    .insert({
      user_id: scope.ownerId,
      company_id: scope.companyId,
      phone_number_id: phoneId,
      file_path: file,
      status: 'queued',
    })
    .returning('*');
  const result = await f.service.importSnapshot(scope, preview.snapshot_id, { list_name: 'Recovered' });
  assert.equal(result.import_job_id, job.id);
  assert.equal(f.counts.imports, 0);
});

test('campaign receipt failures roll back creation; idempotent scheduled retries work after the scheduled time', async () => {
  const f = completedFixture(),
    input = campaignInput();
  const normalCreate = f.deps.createCampaign;
  f.deps.createCampaign = (s, data, committed) =>
    normalCreate(s, data, async () => {
      throw Error('receipt write failed');
    });
  await assert.rejects(f.service.createCampaign(scope, input), /receipt write failed/);
  assert.equal(f.database.tables().campaigns, undefined);
  f.deps.createCampaign = normalCreate;
  input.campaign.scheduled_at = new Date(Date.now() + 1000).toISOString();
  await f.service.createCampaign(scope, input);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal((await f.service.createCampaign(scope, input)).replayed, true);
});

test('Google ranges escape tab names and bound raw preview reads without fetching all rows', async () => {
  const calls = [];
  const { GoogleSheetsClient } = load('src/app/services/googleSheetsClient.service.ts', {
    axios: {
      request: async (input) => {
        calls.push(input);
        return { data: { values: [['Mobile']] } };
      },
    },
    '../utils/googleSheets': utils,
  });
  await new GoogleSheetsClient().rows('sheet-id', "Guests' list", 'token', true);
  assert.ok(decodeURIComponent(calls[0].url).endsWith("'Guests'' list'!A1:CV21"));
  assert.equal(calls[0].params.dateTimeRenderOption, 'FORMATTED_STRING');
});

test('the migration compiles its tables and account-scoped idempotency constraint for PostgreSQL', async () => {
  const knex = require('knex')({ client: 'pg' }),
    statements = [];
  const migration = load('src/database/migrations/20261016000001_create_google_sheets.ts');
  const mock = {
    raw: knex.raw.bind(knex),
    fn: knex.fn,
    schema: {
      async createTable(name, callback) {
        statements.push(
          ...knex.schema
            .createTable(name, callback)
            .toSQL()
            .map((s) => s.sql),
        );
      },
    },
  };
  await migration.up(mock);
  const sql = statements.join('\n');
  assert.match(sql, /create table "google_sheet_connections"/);
  assert.match(sql, /primary key \("company_id", "owner_id", "request_id"\)/);
  assert.match(sql, /"campaign_id".*references "campaigns"/);
  await knex.destroy();
});

test('scheduling rejects ambiguous timestamps, conflicting send modes and non-boolean acceptance', async () => {
  const f = completedFixture(),
    input = campaignInput();
  for (const scheduled_at of ['2027-01-01', '2027-01-01T10:30:00', 'not-a-date']) {
    await assert.rejects(
      f.service.createCampaign(scope, { ...input, campaign: { ...input.campaign, scheduled_at } }),
      /time zone/,
    );
  }
  await assert.rejects(
    f.service.createCampaign(scope, {
      ...input,
      campaign: { ...input.campaign, send_immediately: true, scheduled_at: '2027-01-01T10:30:00Z' },
    }),
    /not both/,
  );
  await assert.rejects(f.service.createCampaign(scope, { ...input, accept_partial_import: 'true' }), /boolean/);
  assert.equal(f.counts.campaigns, 0);
});

test('base middleware restricts credentialed Google CORS without changing other routes or raw webhooks', async () => {
  const express = require('express'),
    logged = [];
  const priorMode = process.env.WORKER_MODE,
    priorOrigin = process.env.GOOGLE_FRONTEND_URL;
  process.env.WORKER_MODE = 'true';
  process.env.GOOGLE_FRONTEND_URL = 'https://dashboard.example.test';
  const routes = express.Router();
  routes.get('/admin/google-sheets/setup', (_req, res) => res.json({ ready: true }));
  routes.get('/integrations/google/callback', (_req, res) => res.sendStatus(200));
  routes.get('/other', (_req, res) => res.sendStatus(200));
  routes.post('/facebook/webhook', (req, res) => res.json({ raw: req.rawBody.toString('hex') }));
  const createApp = load('library/surefy/src/server.ts', {
    './utils/asyncRouter': require('../library/surefy/src/utils/asyncRouter'),
    './middleware/requestCapacity': require('../library/surefy/src/middleware/requestCapacity'),
    './exceptions/CustomError': { CustomError },
    './middleware/errorHandler': { errorHandler: (e, _req, res, _next) => res.status(500).send('error') },
    './routes/health.route': express.Router(),
    './middleware/upload.middleware': { UPLOADS_DIR: runtime },
    morgan: (_format, options) => (req, _res, next) => {
      if (!options.skip(req)) logged.push(req.originalUrl);
      next();
    },
  }).default;
  const app = createApp([{ basePath: '/v1', route: routes }]);
  if (priorMode === undefined) delete process.env.WORKER_MODE;
  else process.env.WORKER_MODE = priorMode;
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const preflight = await fetch(base + '/v1/admin/google-sheets/setup', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://dashboard.example.test',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://dashboard.example.test');
    assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
    const other = await fetch(base + '/v1/other', { headers: { Origin: 'https://another.example.test' } });
    assert.equal(other.headers.get('access-control-allow-origin'), '*');
    const body = '{ "entry": [] }';
    const webhook = await fetch(base + '/v1/facebook/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.equal((await webhook.json()).raw, Buffer.from(body).toString('hex'));
    await fetch(base + '/v1/integrations/google/callback?code=secret-code');
    assert.ok(!logged.some((url) => url.includes('secret-code')));
  } finally {
    if (priorOrigin === undefined) delete process.env.GOOGLE_FRONTEND_URL;
    else process.env.GOOGLE_FRONTEND_URL = priorOrigin;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
