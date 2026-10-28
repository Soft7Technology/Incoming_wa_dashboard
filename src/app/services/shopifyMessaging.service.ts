import { Knex } from 'knex';
import { randomUUID } from 'crypto';
import db from '@surefy/database';
import { ShopifyScope, owner, identifier, fail, decrypt } from '../utils/shopify';
import {
  messagingTopics,
  messagingFields,
  privacyMatch,
  requiredShopifyVariables,
  renderShopifyTemplate,
  shopifyContext,
} from '../utils/shopifyMessaging';

type Sender = (data: any, resolved: any) => Promise<any>;
type Blocked = (phone: any, recipient: string) => Promise<boolean>;
export class ShopifyMessagingService {
  constructor(
    private database: Knex = db,
    private send: Sender = async (data, resolved) =>
      (await import('./message.service')).default.sendMessage(data, resolved),
    private blocked: Blocked = async (phone, recipient) =>
      (await import('./contactOptOut.service')).default.isBlocked(phone, recipient),
  ) {}

  private async owned(scope: ShopifyScope, id: unknown, database = this.database) {
    owner(scope);
    const c = await database('shopify_connections')
      .where({ id: identifier(id), company_id: scope.companyId, owner_id: scope.ownerId })
      .first();
    if (!c) fail(404, 'Shopify connection not found in your account.');
    return c;
  }
  private async assets(database: Knex | Knex.Transaction, c: any, phoneId: unknown, templateId?: unknown) {
    const phone = await database('phone_numbers')
      .where({ id: identifier(phoneId), company_id: c.company_id, user_id: c.owner_id, status: 'active' })
      .whereNull('deleted_at')
      .first();
    if (!phone) fail(400, 'Select an active WhatsApp number belonging to this account.');
    const waba = await database('waba_accounts')
      .where({ id: phone.waba_id, company_id: c.company_id, user_id: c.owner_id })
      .whereNull('deleted_at')
      .first();
    if (!waba) fail(400, 'The WhatsApp business account is unavailable.');
    const template = templateId
      ? await database('templates')
          .where({
            id: identifier(templateId),
            company_id: c.company_id,
            waba_id: phone.waba_id,
            status: 'APPROVED',
            category: 'UTILITY',
          })
          .whereNull('deleted_at')
          .first()
      : undefined;
    if (templateId && !template) fail(400, 'Select an approved utility template for this WhatsApp number.');
    return { phone, template };
  }
  async settings(scope: ShopifyScope, id: unknown, phoneId?: unknown) {
    const c = await this.owned(scope, id);
    const senders = await this.database('phone_numbers')
      .where({ company_id: c.company_id, user_id: c.owner_id, status: 'active' })
      .whereNull('deleted_at')
      .select('id', 'display_phone_number')
      .limit(200);
    let templates: any[] = [];
    if (phoneId) {
      const { phone } = await this.assets(this.database, c, phoneId);
      const rows = await this.database('templates')
        .where({ company_id: c.company_id, waba_id: phone.waba_id, status: 'APPROVED', category: 'UTILITY' })
        .whereNull('deleted_at')
        .limit(200);
      templates = rows.map((t) => {
        const variables = requiredShopifyVariables(t);
        try {
          renderShopifyTemplate(t, Object.fromEntries(variables.map((k) => [k, { literal: 'Example' }])), {});
          return { id: t.id, name: t.name, language: t.language, components: t.components, variables, supported: true };
        } catch {
          return { id: t.id, name: t.name, language: t.language, supported: false };
        }
      });
    }
    const rules = await this.database('shopify_whatsapp_rules')
      .where({ connection_id: c.id })
      .select(
        'topic',
        'enabled',
        'phone_number_id',
        'template_id',
        'parameter_mapping',
        'consent_attribute',
        'updated_at',
      );
    return { senders, templates, rules, topics: messagingTopics, fields: messagingFields };
  }
  async saveRule(scope: ShopifyScope, id: unknown, topic: unknown, input: any) {
    if (typeof topic !== 'string' || !messagingTopics.includes(topic)) fail(400, 'Select a supported order event.');
    if (typeof input?.enabled !== 'boolean') fail(400, 'enabled must be true or false.');
    const initial = await this.owned(scope, id);
    return this.database.transaction(async (trx) => {
      await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`shopify:${initial.shop_domain}`]);
      const c = await this.owned(scope, id, trx);
      const prior = await trx('shopify_whatsapp_rules').where({ connection_id: c.id, topic }).first();
      if (!input.enabled) {
        if (prior)
          await trx('shopify_whatsapp_rules')
            .where({ id: prior.id })
            .update({ enabled: false, revision: randomUUID(), updated_at: new Date() });
        await trx('shopify_whatsapp_jobs')
          .where({ connection_id: c.id, topic, status: 'queued' })
          .update({ status: 'cancelled', reason: 'rule_disabled', payload_ciphertext: null, finished_at: new Date() });
        return { saved: true, enabled: false };
      }
      if (c.status !== 'connected' || !c.desired_topics.includes(topic))
        fail(400, 'Connect the store and save this event in Choose your triggers first.');
      if (input.consent_confirmed !== true)
        fail(400, 'Confirm that your checkout attribute records customer consent to business order messages.');
      if (typeof input.consent_attribute !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(input.consent_attribute))
        fail(
          400,
          'consent_attribute must be a checkout order-attribute name, up to 80 letters, digits or underscores.',
        );
      const { template } = await this.assets(trx, c, input.phone_number_id, input.template_id);
      try {
        renderShopifyTemplate(
          template,
          input.parameter_mapping,
          Object.fromEntries(messagingFields.map((k) => [k, 'Example'])),
        );
      } catch (e) {
        fail(400, e instanceof Error ? e.message : 'Invalid template mapping.');
      }
      const record = {
        connection_id: c.id,
        topic,
        enabled: true,
        phone_number_id: input.phone_number_id,
        template_id: input.template_id,
        parameter_mapping: JSON.stringify(input.parameter_mapping),
        consent_attribute: input.consent_attribute,
        revision: randomUUID(),
        updated_at: new Date(),
      };
      await trx('shopify_whatsapp_rules').insert(record).onConflict(['connection_id', 'topic']).merge(record);
      await trx('shopify_data_access_log').insert({
        connection_id: c.id,
        actor_id: scope.userId,
        action: 'whatsapp.rule.save',
        target_id: c.id,
      });
      return { saved: true, enabled: true };
    });
  }
  async jobs(scope: ShopifyScope, id: unknown) {
    const c = await this.owned(scope, id);
    return {
      jobs: await this.database('shopify_whatsapp_jobs')
        .where({ connection_id: c.id })
        .orderBy('created_at', 'desc')
        .limit(50)
        .select('id', 'topic', 'resource_id', 'status', 'reason', 'created_at', 'finished_at'),
    };
  }
  async claim() {
    return this.database.transaction(async (trx) => {
      const job = await trx('shopify_whatsapp_jobs')
        .where({ status: 'queued' })
        .orderBy('created_at', 'asc')
        .forUpdate()
        .skipLocked()
        .first();
      if (!job) return null;
      await trx('shopify_whatsapp_jobs')
        .where({ id: job.id, status: 'queued' })
        .update({ status: 'sending', started_at: new Date() });
      return job;
    });
  }
  async process(job: any) {
    const initial = await this.database('shopify_connections').where({ id: job.connection_id }).first();
    if (!initial) return;
    await this.database.transaction(async (trx) => {
      // Privacy and disconnect handlers use the same lock. They cannot acknowledge erasure while this send is in flight.
      await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`shopify:${initial.shop_domain}`]);
      const c = await trx('shopify_connections').where({ id: job.connection_id }).first();
      if (!c) return;
      const current = await trx('shopify_whatsapp_jobs')
        .where({ id: job.id, connection_id: c.id, status: 'sending' })
        .first();
      if (!current) return;
      const finish = async (status: string, reason: string | null, purge = true) => {
        await trx('shopify_whatsapp_jobs')
          .where({ id: job.id })
          .update({ status, reason, finished_at: new Date(), ...(purge ? { payload_ciphertext: null } : {}) });
      };
      const rule = await trx('shopify_whatsapp_rules')
        .where({ id: job.rule_id, connection_id: c.id, enabled: true })
        .first();
      if (c.status !== 'connected' || !c.desired_topics.includes(job.topic))
        return finish('cancelled', 'store_disconnected');
      if (!rule || rule.revision !== job.rule_revision) return finish('cancelled', 'rule_changed');
      if (new Date(current.send_before).getTime() <= Date.now()) return finish('cancelled', 'queue_expired');
      if (
        (await privacyMatch(
          trx('shopify_privacy_requests').where({ connection_id: c.id, topic: 'customers/redact', status: 'pending' }),
          current.subject_hashes,
        ).first()) ||
        (await trx('shopify_redactions')
          .where({ connection_id: c.id })
          .whereIn('subject_hash', current.subject_hashes)
          .where('expires_at', '>', new Date())
          .first())
      )
        return finish('cancelled', 'customer_erased');
      let assets: any, snapshot: any, rendered: any;
      try {
        assets = await this.assets(trx, c, rule.phone_number_id, rule.template_id);
        snapshot = JSON.parse(decrypt(current.payload_ciphertext, shopifyContext(c)));
        if (snapshot.consent?.attribute !== rule.consent_attribute) throw Error('Consent changed');
        rendered = renderShopifyTemplate(assets.template, rule.parameter_mapping, snapshot.fields);
      } catch (error: any) {
        if (error?.code && /^\d|^ECONN|^ETIMEDOUT/.test(error.code)) throw error;
        return finish('skipped', 'configuration_or_order_fields_unavailable');
      }
      const recipient = snapshot.recipient.country_code + snapshot.recipient.phone_number;
      if (await this.blocked(assets.phone, recipient)) return finish('skipped', 'contact_opted_out');
      // A pre-existing outbound record is an attempt, including failed/uncertain attempts. Never call Meta twice.
      const priorMessage = await trx('messages').where({ shopify_job_id: job.id }).first();
      if (priorMessage)
        return finish(
          priorMessage.wamid ? 'sent' : 'unknown',
          priorMessage.wamid ? null : 'send_outcome_unconfirmed',
          false,
        );
      try {
        const result = await this.send(
          {
            user_id: c.owner_id,
            company_id: c.company_id,
            phone_number_id: assets.phone.id,
            messageUUID: job.id,
            shopify_job_id: job.id,
            campaign_id: null,
            type: 'template',
            profile_name: '',
            to: snapshot.recipient.phone_number,
            country_code: snapshot.recipient.country_code,
            template: rendered.template,
          },
          { phoneNumber: assets.phone, templateRecord: assets.template, source: 'shopify' },
        );
        await finish(result.wamid ? 'sent' : 'unknown', result.wamid ? null : 'send_outcome_unconfirmed', false);
      } catch (error: any) {
        // Network errors and failed DB completion can follow an accepted send. No automatic retry.
        if (error?.code === 'CONTACT_OPTED_OUT') return finish('skipped', 'contact_opted_out');
        await finish('unknown', 'send_outcome_unconfirmed', false);
      }
    });
  }
  async recoverStale() {
    const rows = await this.database('shopify_whatsapp_jobs')
      .where({ status: 'sending' })
      .where('started_at', '<', new Date(Date.now() - 5 * 60000))
      .limit(100);
    for (const job of rows) {
      const initial = await this.database('shopify_connections').where({ id: job.connection_id }).first();
      if (!initial) continue;
      await this.database.transaction(async (trx) => {
        const lock = await trx.raw('select pg_try_advisory_xact_lock(hashtext(?)) as locked', [
          `shopify:${initial.shop_domain}`,
        ]);
        if (lock.rows?.[0]?.locked === false) return;
        const message = await trx('messages').where({ shopify_job_id: job.id }).first();
        await trx('shopify_whatsapp_jobs')
          .where({ id: job.id, status: 'sending' })
          .update({
            status: message?.wamid ? 'sent' : 'unknown',
            reason: message?.wamid ? null : 'send_outcome_unconfirmed',
            finished_at: new Date(),
          });
      });
    }
  }
}
export default new ShopifyMessagingService();
