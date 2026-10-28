import { Knex } from 'knex';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as XLSX from 'xlsx';
import db from '@surefy/database';
import { UPLOADS_DIR } from '@surefy/middleware/upload.middleware';
import { CustomError } from '@surefy/exceptions/CustomError';
import { GoogleSheetsClient } from './googleSheetsClient.service';
import {
  GoogleScope,
  canonical,
  configuration,
  decrypt,
  encrypt,
  fail,
  googleFileScope,
  hash,
  identifier,
  owner,
  parseSheet,
  random,
  spreadsheetId,
} from '../utils/googleSheets';

const scopeWhere = (scope: GoogleScope) => ({ company_id: scope.companyId, owner_id: scope.ownerId });
const secret = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const fileFor = (id: string) => path.join(UPLOADS_DIR, '.google-sheets', `${id}.xlsx`);
type Dependencies = {
  queueImport: (scope: GoogleScope, phone: string, file: string, name: string) => Promise<any>;
  importStatus: (scope: GoogleScope, id: string) => Promise<any>;
  createCampaign: (
    scope: GoogleScope,
    data: any,
    committed: (campaign: any, trx: Knex.Transaction) => Promise<void>,
  ) => Promise<any>;
};
const dependencies: Dependencies = {
  async queueImport(scope, phone, file, name) {
    const service = (await import('./contact.service')).default;
    return service.queueContactImport(scope.ownerId, scope.companyId, phone, '', file, name, {
      phoneColumn: 'phone_number',
      nameColumn: 'name',
      emailColumn: 'email',
    });
  },
  async importStatus(scope, id) {
    return (await import('./contact.service')).default.getImportJobStatus(id, {
      userId: scope.ownerId,
      companyId: scope.companyId,
    });
  },
  async createCampaign(scope, data, committed) {
    return (await import('./campaign.service')).default.createCampaign(
      scope.ownerId,
      scope.companyId,
      data,
      false,
      committed,
    );
  },
};

export class GoogleSheetsService {
  constructor(
    private database: Knex = db,
    private google: GoogleSheetsClient = new GoogleSheetsClient(),
    private deps = dependencies,
  ) {}

  async start(scope: GoogleScope) {
    owner(scope);
    const c = configuration(),
      state = random(),
      browser = random(),
      verifier = random();
    await this.database('google_sheet_oauth_sessions').where('expires_at', '<', new Date()).delete();
    await this.database('google_sheet_oauth_sessions').insert({
      ...scopeWhere(scope),
      state_hash: hash(state),
      browser_hash: hash(browser),
      verifier_ciphertext: encrypt(verifier, scope),
      expires_at: new Date(Date.now() + 10 * 60 * 1000),
    });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    const params = {
      client_id: c.clientId,
      redirect_uri: c.redirectUri,
      response_type: 'code',
      scope: googleFileScope,
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    };
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    return { browser, authorization_url: url.toString() };
  }

  async callback(state: unknown, browser: unknown, code: unknown, denied: boolean) {
    if (!secret(state) || !secret(browser))
      fail(400, 'Invalid or missing Google OAuth browser session. Start Connect Google again.');
    const [session] = await this.database('google_sheet_oauth_sessions')
      .where({ state_hash: hash(state as string), browser_hash: hash(browser as string) })
      .whereNull('consumed_at')
      .where('expires_at', '>', new Date())
      .update({ consumed_at: new Date() })
      .returning('*');
    if (!session) fail(400, 'Google authorization session expired or was already used.');
    if (denied) return { connected: false, reason: 'access_denied' };
    if (typeof code !== 'string' || !code || code.length > 4096) fail(400, 'Missing Google authorization code.');
    const scope = { companyId: session.company_id, ownerId: session.owner_id, userId: session.owner_id };
    const tokens = await this.google.exchange(code as string, decrypt(session.verifier_ciphertext, scope));
    await this.database.transaction(async (trx) => {
      const user = await trx('users')
        .where({ id: scope.ownerId, company_id: scope.companyId, status: 'active' })
        .whereNull('deleted_at')
        .forUpdate()
        .first();
      const company = await trx('companies')
        .where({ id: scope.companyId, status: 'active' })
        .whereNull('deleted_at')
        .first();
      if (
        !user ||
        !company ||
        !(await trx('google_sheet_oauth_sessions').where({ state_hash: session.state_hash }).first())
      )
        fail(403, 'Google connection was cancelled or the account is inactive.');
      const record = {
        ...scopeWhere(scope),
        access_token_ciphertext: encrypt(this.validToken(tokens), scope),
        refresh_token_ciphertext: encrypt(tokens.refresh_token, scope),
        token_expires_at: this.expiry(tokens),
        updated_at: new Date(),
      };
      await trx('google_sheet_connections').insert(record).onConflict(['company_id', 'owner_id']).merge(record);
    });
    return { connected: true };
  }

  private validToken(tokens: any): string {
    if (typeof tokens?.access_token !== 'string' || !tokens.access_token || tokens.access_token.length > 16384)
      fail(502, 'Google returned an invalid access token.');
    return tokens.access_token;
  }
  private expiry(tokens: any) {
    const seconds = Number(tokens.expires_in);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400)
      fail(502, 'Google returned an invalid token expiry.');
    return new Date(Date.now() + seconds * 1000);
  }
  async connection(scope: GoogleScope) {
    owner(scope);
    const connection = await this.database('google_sheet_connections')
      .where(scopeWhere(scope))
      .first('id', 'created_at', 'updated_at');
    return { connected: Boolean(connection), connection: connection || null };
  }
  private async token(scope: GoogleScope) {
    owner(scope);
    configuration();
    return this.database.transaction(async (trx) => {
      const row = await trx('google_sheet_connections').where(scopeWhere(scope)).forUpdate().first();
      if (!row) fail(409, 'Connect Google before selecting a spreadsheet.');
      if (new Date(row.token_expires_at).getTime() > Date.now() + 60000)
        return { token: decrypt(row.access_token_ciphertext, scope), id: row.id };
      const tokens = await this.google.refresh(decrypt(row.refresh_token_ciphertext, scope));
      const access = this.validToken(tokens);
      await trx('google_sheet_connections')
        .where({ id: row.id })
        .update({
          access_token_ciphertext: encrypt(access, scope),
          token_expires_at: this.expiry(tokens),
          updated_at: new Date(),
          ...(tokens.refresh_token ? { refresh_token_ciphertext: encrypt(tokens.refresh_token, scope) } : {}),
        });
      return { token: access, id: row.id };
    });
  }
  async pickerToken(scope: GoogleScope) {
    const { token } = await this.token(scope);
    return {
      access_token: token,
      scope: googleFileScope,
      purpose: 'Use only with Google Picker to select spreadsheets.',
    };
  }
  async automation(scope: GoogleScope, connectionId: string, key: string, input: Record<string, any>) {
    const credentials = await this.token(scope);
    if (credentials.id !== connectionId) fail(404, 'Google Sheets connection not found in your account');
    return this.google.automation(key, input, credentials.token);
  }
  async spreadsheets(scope: GoogleScope, pageToken: unknown) {
    if (pageToken !== undefined && (typeof pageToken !== 'string' || pageToken.length > 2048))
      fail(400, 'Invalid page_token.');
    const { token } = await this.token(scope);
    return this.google.get('drive/v3/files', token, {
      q: "mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
      fields: 'nextPageToken,files(id,name,modifiedTime,webViewLink)',
      pageSize: 100,
      ...(pageToken ? { pageToken } : {}),
    });
  }
  async tabs(scope: GoogleScope, input: unknown) {
    const id = spreadsheetId(input),
      { token } = await this.token(scope);
    return this.google.metadata(id, token);
  }
  async sample(scope: GoogleScope, input: unknown, sheetId: unknown) {
    const id = spreadsheetId(input);
    if (typeof sheetId !== 'string' || !/^\d{1,10}$/.test(sheetId)) fail(400, 'sheet_id must be the numeric tab ID.');
    const { token } = await this.token(scope),
      metadata = await this.google.metadata(id, token);
    const tab = metadata.sheets?.find((sheet: any) => sheet.properties?.sheetId === Number(sheetId))?.properties;
    if (!tab) fail(404, 'Spreadsheet tab not found.');
    if (!tab.gridProperties || tab.gridProperties.columnCount > 100) fail(413, 'Use a tab with at most 100 columns.');
    const values = await this.google.rows(id, tab.title, token, true);
    return { sheet_id: Number(sheetId), title: tab.title, headers: values[0] || [], sample_rows: values.slice(1, 21) };
  }
  private async phone(scope: GoogleScope, id: unknown) {
    identifier(id, 'phone_number_id');
    const row = await this.database('phone_numbers')
      .where({ id, user_id: scope.ownerId, company_id: scope.companyId })
      .whereNull('deleted_at')
      .first();
    if (!row) fail(404, 'Sending phone number not found in your account.');
    return row;
  }
  async preview(scope: GoogleScope, input: any) {
    owner(scope);
    const id = spreadsheetId(input?.spreadsheet_id);
    if (!Number.isSafeInteger(input?.sheet_id) || input.sheet_id < 0) fail(400, 'sheet_id must be the numeric tab ID.');
    if (input.country_code !== undefined && (typeof input.country_code !== 'string' || input.country_code.length > 8))
      fail(400, 'country_code must be a calling code or ISO country code string.');
    const phone = await this.phone(scope, input.phone_number_id),
      { token, id: connectionId } = await this.token(scope);
    const metadata = await this.google.metadata(id, token);
    const tab = metadata.sheets?.find((sheet: any) => sheet.properties?.sheetId === input.sheet_id)?.properties;
    if (!tab || typeof tab.title !== 'string') fail(404, 'Spreadsheet tab not found.');
    if (!tab.gridProperties || tab.gridProperties.columnCount > 100) fail(413, 'Use a tab with at most 100 columns.');
    const values = await this.google.rows(id, tab.title, token);
    const parsed = parseSheet(values, input.mapping, input.country_code || '');
    if (Buffer.byteLength(JSON.stringify(parsed)) > 4 * 1024 * 1024)
      fail(413, 'Sheet snapshot exceeds 4 MB. Split the tab before importing.');
    const [saved] = await this.database('google_sheet_snapshots')
      .insert({
        ...scopeWhere(scope),
        phone_number_id: phone.id,
        connection_id: connectionId,
        source: JSON.stringify({
          spreadsheet_id: id,
          sheet_id: input.sheet_id,
          title: tab.title,
          mapping: input.mapping,
        }),
        headers: JSON.stringify(parsed.headers),
        rows: JSON.stringify(parsed.rows),
        summary: JSON.stringify(parsed.summary),
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
      })
      .returning(['id', 'created_at', 'expires_at']);
    return {
      snapshot_id: saved.id,
      created_at: saved.created_at,
      expires_at: saved.expires_at,
      summary: parsed.summary,
      headers: parsed.headers,
      sample_rows: parsed.rows.slice(0, 20),
    };
  }
  async snapshots(scope: GoogleScope) {
    owner(scope);
    return this.database('google_sheet_snapshots')
      .where(scopeWhere(scope))
      .orderBy('created_at', 'desc')
      .limit(50)
      .select('id', 'source', 'summary', 'phone_number_id', 'import_job_id', 'created_at', 'expires_at');
  }
  private async snapshot(scope: GoogleScope, id: string, database = this.database, lock = false) {
    owner(scope);
    identifier(id, 'snapshot_id');
    let query = database('google_sheet_snapshots').where({ id, ...scopeWhere(scope) });
    if (lock) query = query.forUpdate();
    const row = await query.first();
    if (!row) fail(404, 'Sheet snapshot not found in your account.');
    return row;
  }
  async importSnapshot(scope: GoogleScope, id: string, input: any) {
    const name = input?.list_name;
    if (typeof name !== 'string' || !name.trim() || name.length > 200)
      fail(400, 'list_name is required (maximum 200 characters).');
    const job = await this.database.transaction(async (trx) => {
      const snapshot = await this.snapshot(scope, id, trx, true);
      await this.phone(scope, snapshot.phone_number_id);
      // Stable file path recovers an import queued before a lost transaction acknowledgement.
      const file = fileFor(id);
      const existing = await trx('import_jobs')
        .where({ user_id: scope.ownerId, company_id: scope.companyId, file_path: file })
        .whereNull('deleted_at')
        .first();
      if (existing) {
        await trx('google_sheet_snapshots')
          .where({ id })
          .update({ import_job_id: existing.id, updated_at: new Date() });
        return existing;
      }
      if (new Date(snapshot.expires_at).getTime() <= Date.now())
        fail(409, 'This preview expired. Preview the sheet again.');
      if (!snapshot.rows.length)
        fail(400, 'This snapshot has no valid recipients. Correct the sheet and preview again.');
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([snapshot.headers, ...snapshot.rows]), 'Contacts');
      await fs.writeFile(file, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { mode: 0o600 });
      const created = await this.deps.queueImport(scope, snapshot.phone_number_id, file, name.trim());
      await trx('google_sheet_snapshots').where({ id }).update({ import_job_id: created.id, updated_at: new Date() });
      return created;
    });
    return {
      snapshot_id: id,
      import_job_id: job.id,
      status: job.status,
      status_url: `/v1/admin/google-sheets/snapshots/${id}/import`,
    };
  }
  async importStatus(scope: GoogleScope, id: string) {
    const snapshot = await this.snapshot(scope, id);
    if (!snapshot.import_job_id) fail(409, 'Import this snapshot first.');
    return this.deps.importStatus(scope, snapshot.import_job_id);
  }
  async createCampaign(scope: GoogleScope, input: any) {
    owner(scope);
    const requestId = input?.request_id;
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(requestId))
      fail(400, 'request_id is required. Use a unique ID for each campaign and reuse it only for retries.');
    const snapshotId = identifier(input?.snapshot_id, 'snapshot_id');
    const config = input?.campaign;
    if (
      !config ||
      typeof config !== 'object' ||
      Array.isArray(config) ||
      typeof config.name !== 'string' ||
      !config.name.trim() ||
      config.name.length > 200
    )
      fail(400, 'campaign.name is required (maximum 200 characters).');
    identifier(config.template_id, 'campaign.template_id');
    if (config.send_immediately !== undefined && typeof config.send_immediately !== 'boolean')
      fail(400, 'send_immediately must be a boolean.');
    if (input.accept_partial_import !== undefined && typeof input.accept_partial_import !== 'boolean')
      fail(400, 'accept_partial_import must be a boolean.');
    if (
      config.scheduled_at !== undefined &&
      (typeof config.scheduled_at !== 'string' ||
        (config.scheduled_at !== 'now' &&
          (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(config.scheduled_at) ||
            !Number.isFinite(Date.parse(config.scheduled_at)))))
    )
      fail(400, 'scheduled_at must be now or a future ISO timestamp with a time zone.');
    if (config.send_immediately && config.scheduled_at && config.scheduled_at !== 'now')
      fail(400, 'Choose immediate sending or scheduled_at, not both.');
    if (
      config.description !== undefined &&
      (typeof config.description !== 'string' || config.description.length > 2000)
    )
      fail(400, 'description must be text of at most 2000 characters.');
    if (
      Object.keys(config).some(
        (k) =>
          ![
            'name',
            'description',
            'template_id',
            'parameter_mapping',
            'media_uploads',
            'scheduled_at',
            'send_immediately',
          ].includes(k),
      )
    )
      fail(400, 'Unsupported campaign setting. Recipients and sender come from the saved import.');
    const fingerprint = hash(
      canonical({
        snapshot_id: snapshotId,
        campaign: config,
        accept_partial_import: input.accept_partial_import === true,
      }),
    );
    const replay = async () => {
      const receipt = await this.database('google_sheet_campaign_requests')
        .where({ ...scopeWhere(scope), request_id: requestId })
        .first();
      if (!receipt) return null;
      if (receipt.payload_hash !== fingerprint)
        fail(409, 'request_id was already used for different campaign settings.');
      const campaign =
        receipt.campaign_id &&
        (await this.database('campaigns')
          .where({ id: receipt.campaign_id, user_id: scope.ownerId, company_id: scope.companyId })
          .whereNull('deleted_at')
          .first());
      if (!campaign) fail(409, 'The campaign for this request was deleted. Use a new request_id to create another.');
      return { campaign, replayed: true };
    };
    const previous = await replay();
    if (previous) return previous;
    if (config.scheduled_at && config.scheduled_at !== 'now' && Date.parse(config.scheduled_at) <= Date.now())
      fail(400, 'scheduled_at must be in the future.');
    const snapshot = await this.snapshot(scope, snapshotId);
    const job =
      snapshot.import_job_id &&
      (await this.database('import_jobs')
        .where({
          id: snapshot.import_job_id,
          user_id: scope.ownerId,
          company_id: scope.companyId,
          phone_number_id: snapshot.phone_number_id,
        })
        .whereNull('deleted_at')
        .first());
    if (!job || job.status !== 'completed' || !job.list_id)
      fail(409, 'Wait for the sheet contact import to complete before creating a campaign.');
    if (Number(job.failed_rows || 0) > 0 && input.accept_partial_import !== true)
      fail(
        409,
        'Some contacts failed to import. Review the import report and set accept_partial_import=true to use the successful contacts.',
      );
    const phone = await this.phone(scope, snapshot.phone_number_id);
    const template = await this.database('templates')
      .where({ id: config.template_id, company_id: scope.companyId, waba_id: phone.waba_id, status: 'APPROVED' })
      .whereNull('deleted_at')
      .first();
    if (!template) fail(404, 'Approved template not found for this sender account.');
    const data = {
      name: config.name.trim(),
      description: config.description,
      template_id: config.template_id,
      phone_number_id: phone.id,
      contact_filters: { list_ids: [job.list_id], exclude_invalid: true },
      parameter_mapping: config.parameter_mapping,
      media_uploads: config.media_uploads,
      scheduled_at: config.scheduled_at,
      send_immediately: config.send_immediately,
    };
    try {
      const campaign = await this.deps.createCampaign(scope, data, async (created, trx) => {
        await trx('google_sheet_campaign_requests').insert({
          ...scopeWhere(scope),
          request_id: requestId,
          payload_hash: fingerprint,
          snapshot_id: snapshotId,
          campaign_id: created.id,
        });
      });
      return { campaign, replayed: false };
    } catch (error: any) {
      // Also covers a concurrent duplicate reaching a plan limit after the first
      // request committed, and a lost acknowledgement after a successful commit.
      const duplicate = await replay();
      if (duplicate) return duplicate;
      throw error;
    }
  }
  async bulkCampaigns(scope: GoogleScope, input: any) {
    owner(scope);
    if (!Array.isArray(input?.campaigns) || input.campaigns.length < 1 || input.campaigns.length > 10)
      fail(400, 'campaigns must contain between 1 and 10 campaign requests.');
    const results = [];
    for (const [index, item] of input.campaigns.entries()) {
      try {
        results.push({ index, success: true, ...(await this.createCampaign(scope, item)) });
      } catch (e) {
        if (!(e instanceof CustomError)) throw e;
        results.push({ index, success: false, status: e.statusCode, message: e.message });
      }
    }
    return {
      results,
      succeeded: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
    };
  }
  async disconnect(scope: GoogleScope) {
    owner(scope);
    // Lock order matches OAuth completion, so a pending callback cannot restore a disconnected session.
    await this.database.transaction(async (trx) => {
      await trx('users').where({ id: scope.ownerId }).forUpdate().first();
      await trx('google_sheet_oauth_sessions').where(scopeWhere(scope)).delete();
      const row = await trx('google_sheet_connections').where(scopeWhere(scope)).forUpdate().first();
      if (!row) return;
      try {
        await this.google.revoke(decrypt(row.refresh_token_ciphertext, scope));
      } catch (error) {
        if (!(error instanceof CustomError && error.statusCode === 401)) throw error;
      }
      await trx('google_sheet_connections').where({ id: row.id }).delete();
    });
    return { connected: false };
  }
}
export default new GoogleSheetsService();
