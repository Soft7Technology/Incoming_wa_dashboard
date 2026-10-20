import { Knex } from 'knex';
import { parseImportedPhone } from './importPhone';
import { encrypt, expiresAt, hash, scalarId } from './shopify';
import { templatePreview } from './reminder';

export const messagingTopics = ['orders/create', 'orders/paid', 'orders/cancelled', 'orders/updated'];
export const messagingFields = [
  'order_id',
  'order_number',
  'order_total',
  'currency',
  'payment_status',
  'fulfillment_status',
  'store_name',
  'store_domain',
];
export const shopifyContext = (c: any) => `${c.company_id}:${c.owner_id}:${c.shop_domain}`;
export const privacyMatch = (q: Knex.QueryBuilder, hashes: string[]) =>
  hashes.length
    ? q.where(function () {
        for (const h of hashes) this.orWhereJsonSupersetOf('subject_hashes', [h]);
      })
    : q.whereRaw('false');

export function renderShopifyTemplate(template: any, mapping: any, fields: Record<string, string>) {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw Error('Provide parameter_mapping.');
  const variables: Record<string, string> = {};
  for (const [key, source] of Object.entries(mapping) as [string, any][]) {
    if (
      !/^(header|body)\.[a-zA-Z0-9_]{1,80}$/.test(key) ||
      !source ||
      typeof source !== 'object' ||
      Array.isArray(source)
    )
      throw Error('Invalid template parameter mapping.');
    if (Object.keys(source).length !== 1) throw Error('Map a variable to a field or literal text.');
    if (typeof source.field === 'string' && messagingFields.includes(source.field))
      variables[key] = fields[source.field] || '';
    else if (typeof source.literal === 'string' && source.literal.trim() && source.literal.length <= 500)
      variables[key] = source.literal;
    else throw Error('Select a supported order field or non-empty literal text.');
  }
  // The initial order-message feature deliberately supports utility text templates, not promotions/media.
  if (
    template.category !== 'UTILITY' ||
    template.status !== 'APPROVED' ||
    !Array.isArray(template.components) ||
    !template.components.some((p: any) => String(p.type).toUpperCase() === 'BODY') ||
    template.components.some((p: any) => String(p.type).toUpperCase() === 'HEADER' && p.format && p.format !== 'TEXT')
  )
    throw Error('Select an approved utility template with a text header/body.');
  return templatePreview(template, variables);
}
export function requiredShopifyVariables(template: any): string[] {
  return [
    ...new Set<string>(
      (template.components || []).flatMap((part: any) =>
        [...String(part.text || '').matchAll(/{{\s*([\w]+)\s*}}/g)].map(
          (m) => `${String(part.type).toLowerCase()}.${m[1]}`,
        ),
      ),
    ),
  ];
}
const text = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 100) : '';
export function orderMessageFields(payload: any, connection: any): Record<string, string> {
  return {
    order_id: scalarId(payload.id) || '',
    order_number: text(payload.order_number) || scalarId(payload.id) || '',
    order_total: text(payload.current_total_price ?? payload.total_price),
    currency: text(payload.currency),
    payment_status: text(payload.financial_status),
    fulfillment_status: text(payload.fulfillment_status) || 'unfulfilled',
    store_name: connection.name,
    store_domain: connection.shop_domain,
  };
}

/** Called within the webhook transaction. No Meta calls and no raw webhook persistence. */
export async function enqueueShopifyMessage(
  trx: Knex.Transaction,
  connection: any,
  topic: string,
  payload: any,
  eventId: string,
  hashes: string[],
) {
  if (!messagingTopics.includes(topic)) return;
  const rule = await trx('shopify_whatsapp_rules')
    .where({ connection_id: connection.id, topic, enabled: true })
    .first();
  if (!rule) return;
  const id = scalarId(payload.id);
  const revision =
    topic === 'orders/updated'
      ? text(payload.updated_at) + ':' + text(payload.financial_status) + ':' + text(payload.fulfillment_status)
      : '';
  const dedupe = hash(JSON.stringify([rule.id, topic, id, revision]));
  if (await trx('shopify_whatsapp_jobs').where({ connection_id: connection.id, dedupe_key: dedupe }).first()) return;
  let reason: string | null = null,
    recipient: any;
  if (!id || (topic === 'orders/updated' && !Number.isFinite(Date.parse(payload.updated_at))))
    reason = 'order_identity_missing';
  else if (
    !Array.isArray(payload.note_attributes) ||
    !payload.note_attributes.some(
      (a: any) => a?.name === rule.consent_attribute && (a.value === 'true' || a.value === true),
    )
  )
    reason = 'consent_missing';
  if (!reason) {
    // Do not use shipping contact details, which can identify a different recipient.
    const phone = payload.phone || payload.customer?.phone || payload.billing_address?.phone;
    try {
      if (typeof phone !== 'string' || !/^\s*(\+|00)/.test(phone)) throw Error('International number required');
      recipient = parseImportedPhone(phone);
    } catch {
      reason = 'phone_missing_or_invalid';
    }
  }
  const now = new Date();
  await trx('shopify_whatsapp_jobs').insert({
    connection_id: connection.id,
    rule_id: rule.id,
    rule_revision: rule.revision,
    event_id: eventId,
    dedupe_key: dedupe,
    topic,
    resource_id: id,
    status: reason ? 'skipped' : 'queued',
    reason,
    subject_hashes: JSON.stringify(hashes),
    payload_ciphertext: reason
      ? null
      : encrypt(
          JSON.stringify({
            recipient,
            fields: orderMessageFields(payload, connection),
            consent: { attribute: rule.consent_attribute, received_at: now.toISOString() },
          }),
          shopifyContext(connection),
        ),
    created_at: now,
    send_before: new Date(now.getTime() + 3600000),
    expires_at: expiresAt(now),
  });
}
