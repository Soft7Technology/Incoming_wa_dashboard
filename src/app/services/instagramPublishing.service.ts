import crypto from 'node:crypto';
import net from 'node:net';
import { Knex } from 'knex';
import db from '@surefy/database';
import instagram, { InstagramService } from './instagram.service';
import graph, { InstagramGraph, directInstagramConfig, instagramPublishingPermission } from './instagramGraph.service';
import { FacebookScope } from './facebookMessenger.service';
import { decrypt, FacebookError, hash, random, uuidPattern } from '../utils/facebook';
import {
  cleanPublishingMedia,
  publishingMediaPath,
  removePublishingMedia,
  validatePublishingMedia,
} from '../utils/instagramPublishingMedia';

const fields = [
  'id',
  'kind',
  'caption',
  'status',
  'media_id',
  'permalink',
  'error',
  'created_at',
  'updated_at',
  'last_checked_at',
];
const numeric = (id: unknown): id is string => typeof id === 'string' && /^\d{1,80}$/.test(id);
const failure = (error: unknown) =>
  error instanceof FacebookError && error.status < 500
    ? error.message
    : 'Instagram did not confirm the operation. Check its status before trying another post.';

export class InstagramPublishingService {
  constructor(
    private database: Knex = db,
    private accounts: InstagramService = instagram,
    private meta: InstagramGraph = graph,
  ) {}

  async authorize(scope: FacebookScope, id: string) {
    const account = await this.accounts.account(scope, id);
    if (account.auth_provider !== 'instagram')
      throw new FacebookError(409, 'Connect this account with Instagram to publish posts.');
    if (
      Array.isArray(account.granted_permissions) &&
      !account.granted_permissions.includes(instagramPublishingPermission)
    )
      throw new FacebookError(
        403,
        'Reconnect with Instagram and grant instagram_business_content_publish to publish.',
        'PUBLISHING_PERMISSION_REQUIRED',
      );
    return account;
  }

  async settings(scope: FacebookScope, id: string) {
    const account = await this.accounts.account(scope, id, false);
    const allowed =
      account.auth_provider === 'instagram' &&
      account.status === 'connected' &&
      (!Array.isArray(account.granted_permissions) ||
        account.granted_permissions.includes(instagramPublishingPermission));
    return {
      allowed,
      permission: instagramPublishingPermission,
      permission_verified: Array.isArray(account.granted_permissions),
      issue: allowed ? null : 'Reconnect with Instagram and grant publishing access.',
      max_photo_bytes: 8 * 1024 * 1024,
      max_video_bytes: 100 * 1024 * 1024,
    };
  }

  async saveAsset(scope: FacebookScope, id: string, file?: Express.Multer.File) {
    if (!file) throw new FacebookError(400, 'Choose a JPEG photo or MP4 Reel.');
    try {
      await this.authorize(scope, id);
      const kind = await validatePublishingMedia(file);
      const token = random(),
        assetId = crypto.randomUUID();
      const mediaUrl = `${directInstagramConfig().base}/v1/facebook/instagram/publishing/media/${token}`;
      const expires = new Date(Date.now() + 24 * 3600000);
      await this.database('instagram_publish_assets').insert({
        id: assetId,
        account_id: id,
        token_hash: hash(token),
        filename: file.filename,
        kind,
        media_url: mediaUrl,
        expires_at: expires,
      });
      await cleanPublishingMedia().catch(() => {});
      return { asset_id: assetId, kind, media_url: mediaUrl, expires_at: expires };
    } catch (error) {
      await removePublishingMedia(file.filename);
      throw error;
    }
  }

  async publicAsset(token: unknown) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new FacebookError(404, 'Media not found.');
    const asset = await this.database('instagram_publish_assets')
      .where({ token_hash: hash(token) })
      .where('expires_at', '>', new Date())
      .first();
    if (!asset) throw new FacebookError(404, 'Media expired or was removed.');
    return { path: publishingMediaPath(asset.filename), type: asset.kind === 'IMAGE' ? 'image/jpeg' : 'video/mp4' };
  }

  private async row(scope: FacebookScope, id: string, publication: string) {
    await this.accounts.account(scope, id, false);
    if (!uuidPattern.test(publication)) throw new FacebookError(400, 'Invalid publication ID.');
    const row = await this.database('instagram_publications').where({ id: publication, account_id: id }).first();
    if (!row) throw new FacebookError(404, 'Post not found in this account.');
    return row;
  }

  private view(row: any) {
    return Object.fromEntries(fields.map((key) => [key, row[key] ?? null]));
  }

  async list(scope: FacebookScope, id: string) {
    await this.accounts.account(scope, id, false);
    return this.database('instagram_publications')
      .where({ account_id: id })
      .select(fields)
      .orderBy('created_at', 'desc')
      .limit(50);
  }

  async create(scope: FacebookScope, id: string, input: any) {
    const a = await this.authorize(scope, id);
    if (!input || !uuidPattern.test(String(input.client_request_id || '')))
      throw new FacebookError(400, 'Provide a UUID client_request_id.');
    if (!['IMAGE', 'REELS'].includes(input.kind)) throw new FacebookError(400, 'Choose a photo or Reel.');
    const caption = input.caption ?? '';
    if (typeof caption !== 'string' || Array.from(caption).length > 2200)
      throw new FacebookError(400, 'Captions can contain up to 2,200 characters.');
    if (input.share_to_feed !== undefined && typeof input.share_to_feed !== 'boolean')
      throw new FacebookError(400, 'share_to_feed must be true or false.');
    let mediaUrl = input.media_url;
    if (input.asset_id) {
      if (!uuidPattern.test(String(input.asset_id))) throw new FacebookError(400, 'Invalid uploaded media ID.');
      const asset = await this.database('instagram_publish_assets')
        .where({ id: input.asset_id, account_id: id })
        .where('expires_at', '>', new Date())
        .first();
      if (!asset || asset.kind !== input.kind)
        throw new FacebookError(
          400,
          'Upload the matching media again; this upload expired or belongs to another account.',
        );
      mediaUrl = asset.media_url;
    }
    let url: URL;
    try {
      url = new URL(mediaUrl);
    } catch {
      throw new FacebookError(400, 'Enter a public HTTPS media URL or upload a file.');
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443') ||
      net.isIP(url.hostname.replace(/^\[|\]$/g, '')) ||
      /(^localhost$|\.(localhost|local|internal)$)/i.test(url.hostname) ||
      String(mediaUrl).length > 4096
    )
      throw new FacebookError(400, 'Use a publicly accessible HTTPS media URL without embedded credentials.');
    const fingerprint = hash(JSON.stringify([input.kind, url.toString(), caption, input.share_to_feed !== false]));
    const row = await this.database.transaction(async (trx) => {
      const current = await trx('instagram_accounts').where({ id }).forUpdate().first();
      if (!current) throw new FacebookError(404, 'Instagram account was removed.');
      this.accounts.assertConnected(current);
      if (
        Array.isArray(current.granted_permissions) &&
        !current.granted_permissions.includes(instagramPublishingPermission)
      )
        throw new FacebookError(
          403,
          'Reconnect with Instagram and grant publishing access.',
          'PUBLISHING_PERMISSION_REQUIRED',
        );
      if (current.auth_provider !== 'instagram' || current.provider_app_id !== a.provider_app_id)
        throw new FacebookError(409, 'The connection changed. Reload the account.');
      const existing = await trx('instagram_publications')
        .where({ account_id: id, client_request_id: input.client_request_id })
        .first();
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new FacebookError(409, 'This request ID was used for different content. Start a new draft.');
        return { ...existing, fresh: false };
      }
      const [created] = await trx('instagram_publications')
        .insert({
          account_id: id,
          client_request_id: input.client_request_id,
          fingerprint,
          kind: input.kind,
          caption,
          media_url: url.toString(),
          share_to_feed: input.share_to_feed !== false,
        })
        .returning('*');
      return { ...created, fresh: true };
    });
    if (!row.fresh) return this.view(row);
    try {
      const container = await this.database.transaction(async (trx) => {
        const current = await trx('instagram_accounts').where({ id }).forUpdate().first();
        if (!current) throw new FacebookError(404, 'Instagram account was removed.');
        this.accounts.assertConnected(current);
        if (
          Array.isArray(current.granted_permissions) &&
          !current.granted_permissions.includes(instagramPublishingPermission)
        )
          throw new FacebookError(
            403,
            'Reconnect with Instagram and grant publishing access.',
            'PUBLISHING_PERMISSION_REQUIRED',
          );
        if (current.auth_provider !== 'instagram' || current.provider_app_id !== a.provider_app_id)
          throw new FacebookError(409, 'The connection changed. Reload the account.');
        const result = await this.meta.call(
          `${current.instagram_id}/media`,
          decrypt(current.token_ciphertext),
          'POST',
          {},
          {
            caption,
            ...(input.kind === 'IMAGE'
              ? { image_url: url.toString() }
              : { video_url: url.toString(), media_type: 'REELS', share_to_feed: input.share_to_feed !== false }),
          },
        );
        if (!numeric(result.id)) throw new FacebookError(502, 'Instagram did not return a media container.');
        await trx('instagram_publications')
          .where({ id: row.id })
          .update({ container_id: result.id, status: 'processing', updated_at: new Date() });
        return result;
      });
      if (container.id) {
        try {
          return await this.refresh(scope, id, row.id);
        } catch {
          return this.view(await this.row(scope, id, row.id));
        }
      }
    } catch (error) {
      await this.database('instagram_publications')
        .where({ id: row.id })
        .update({ status: 'failed', error: failure(error), updated_at: new Date() });
    }
    return this.view(await this.row(scope, id, row.id));
  }

  async refresh(scope: FacebookScope, id: string, publication: string) {
    const row = await this.row(scope, id, publication);
    if (row.status === 'published' || row.status === 'failed') return this.view(row);
    if (!row.container_id) {
      if (new Date(row.created_at).getTime() < Date.now() - 60000) {
        await this.database('instagram_publications')
          .where({ id: row.id, status: 'creating' })
          .update({ status: 'failed', error: 'Media preparation was interrupted. Create a new draft.' });
      }
      return this.view(await this.row(scope, id, publication));
    }
    const a = await this.authorize(scope, id);
    const result = await this.meta.call(row.container_id, decrypt(a.token_ciphertext), 'GET', {
      fields: 'status_code',
    });
    const code = result.status_code;
    if (!['IN_PROGRESS', 'FINISHED', 'PUBLISHED', 'ERROR', 'EXPIRED'].includes(code))
      throw new FacebookError(502, 'Instagram returned an unknown publishing status.');
    return this.database.transaction(async (trx) => {
      const current = await trx('instagram_publications')
        .where({ id: publication, account_id: id })
        .forUpdate()
        .first();
      if (!current) throw new FacebookError(404, 'Post was removed.');
      if (current.status === 'published' || current.status === 'failed') return this.view(current);
      const uncertain = ['publishing', 'unconfirmed'].includes(current.status);
      const status =
        code === 'PUBLISHED'
          ? 'published'
          : ['ERROR', 'EXPIRED'].includes(code)
            ? 'failed'
            : uncertain
              ? current.status
              : code === 'FINISHED'
                ? 'ready'
                : 'processing';
      const [updated] = await trx('instagram_publications')
        .where({ id: publication })
        .update({
          status,
          last_checked_at: new Date(),
          updated_at: new Date(),
          error:
            status === 'failed'
              ? 'Instagram could not process this media, or its container expired. Check its format and create a new draft.'
              : uncertain && status !== 'published'
                ? current.error
                : null,
        })
        .returning('*');
      return this.view(updated);
    });
  }

  async publish(scope: FacebookScope, id: string, publication: string) {
    const a = await this.authorize(scope, id);
    await this.refresh(scope, id, publication);
    const reserved = await this.database.transaction(async (trx) => {
      const current = await trx('instagram_accounts').where({ id }).forUpdate().first();
      if (!current) throw new FacebookError(404, 'Instagram account was removed.');
      this.accounts.assertConnected(current);
      if (
        Array.isArray(current.granted_permissions) &&
        !current.granted_permissions.includes(instagramPublishingPermission)
      )
        throw new FacebookError(
          403,
          'Reconnect with Instagram and grant publishing access.',
          'PUBLISHING_PERMISSION_REQUIRED',
        );
      const row = await trx('instagram_publications').where({ id: publication, account_id: id }).forUpdate().first();
      if (!row) throw new FacebookError(404, 'Post was removed.');
      if (['published', 'publishing', 'unconfirmed'].includes(row.status)) return { ...row, fresh: false };
      if (row.status !== 'ready' || !row.container_id)
        throw new FacebookError(409, 'The media is not ready. Check its status before publishing.');
      await trx('instagram_publications')
        .where({ id: publication })
        .update({ status: 'publishing', updated_at: new Date() });
      return { ...row, fresh: true };
    });
    if (!reserved.fresh) return this.view(reserved);
    try {
      await this.database.transaction(async (trx) => {
        const current = await trx('instagram_accounts').where({ id }).forUpdate().first();
        if (!current) throw new FacebookError(404, 'Instagram account was removed.');
        this.accounts.assertConnected(current);
        if (
          Array.isArray(current.granted_permissions) &&
          !current.granted_permissions.includes(instagramPublishingPermission)
        )
          throw new FacebookError(
            403,
            'Reconnect with Instagram and grant publishing access.',
            'PUBLISHING_PERMISSION_REQUIRED',
          );
        if (current.auth_provider !== 'instagram' || current.provider_app_id !== a.provider_app_id)
          throw new FacebookError(409, 'The connection changed. Reload the account.');
        const result = await this.meta.call(
          `${current.instagram_id}/media_publish`,
          decrypt(current.token_ciphertext),
          'POST',
          {},
          { creation_id: reserved.container_id },
        );
        if (!numeric(result.id)) throw new FacebookError(502, 'Instagram did not confirm publication.');
        await trx('instagram_publications')
          .where({ id: publication })
          .update({ status: 'published', media_id: result.id, error: null, updated_at: new Date() });
      });
    } catch (error) {
      await this.database('instagram_publications')
        .where({ id: publication })
        .update({
          status: error instanceof FacebookError && error.status < 500 ? 'failed' : 'unconfirmed',
          error: failure(error),
          updated_at: new Date(),
        });
      return this.view(await this.row(scope, id, publication));
    }
    const published = await this.row(scope, id, publication);
    try {
      const media = await this.meta.call(published.media_id, decrypt(a.token_ciphertext), 'GET', {
        fields: 'id,caption,media_type,permalink,timestamp',
      });
      if (media.id === published.media_id) {
        const permalink =
          typeof media.permalink === 'string' && /^https:\/\/(www\.)?instagram\.com\//.test(media.permalink)
            ? media.permalink
            : null;
        await this.database('instagram_publications').where({ id: publication }).update({ permalink });
        await this.accounts.put(
          this.database,
          id,
          'media',
          media.id,
          null,
          {
            caption: media.caption || published.caption,
            media_type: media.media_type || published.kind,
            permalink: permalink || '',
          },
          new Date(),
        );
      }
    } catch {
      /* The publication is confirmed even if metadata retrieval fails. */
    }
    return this.view(await this.row(scope, id, publication));
  }
}

export default new InstagramPublishingService();
