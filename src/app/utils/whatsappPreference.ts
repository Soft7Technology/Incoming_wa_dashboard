import HTTP403Error from '@surefy/exceptions/HTTP403Error';

export type PreferenceScope = 'all' | 'marketing';
export type PreferenceStatus = 'opted_in' | 'opted_out';
export type PreferenceCommand = { action: 'STOP' | 'START' | 'HELP'; scope: PreferenceScope; source: string };
export const staffPreferenceSources = ['web_form', 'phone_call', 'email', 'in_person', 'support_ticket', 'other'];
export const normalizePreferenceKeyword = (value: unknown) => typeof value === 'string'
  ? value.normalize('NFKC').replace(/[\u200B-\u200F\uFEFF]/g, '').trim().toUpperCase() : '';

export function preferenceCommand(message: any): PreferenceCommand | null {
  const button = message?.interactive?.button_reply?.id ?? message?.interactive?.list_reply?.id ?? message?.button?.payload;
  const key = normalizePreferenceKeyword(button ?? message?.text?.body);
  const source = button !== undefined ? 'whatsapp_button' : 'whatsapp_keyword';
  if (['STOP', 'UNSUBSCRIBE', 'WA_OPT_OUT_ALL'].includes(key)) return { action: 'STOP', scope: 'all', source };
  if (['START', 'WA_OPT_IN_ALL'].includes(key)) return { action: 'START', scope: 'all', source };
  if (['HELP', 'WA_HELP'].includes(key)) return { action: 'HELP', scope: 'all', source };
  if (button !== undefined && key === 'WA_OPT_OUT_MARKETING') return { action: 'STOP', scope: 'marketing', source };
  if (button !== undefined && key === 'WA_OPT_IN_MARKETING') return { action: 'START', scope: 'marketing', source };
  return null;
}

export function affirmativeConsentReply(message: any): boolean {
  return ['YES', 'ACCEPT'].includes(normalizePreferenceKeyword(
    message?.interactive?.button_reply?.id ?? message?.button?.payload ?? message?.text?.body,
  ));
}

export class WhatsAppSuppressedError extends HTTP403Error {
  constructor(public code: 'WHATSAPP_OPTED_OUT' | 'WHATSAPP_CONSENT_REQUIRED' | 'WHATSAPP_WINDOW_CLOSED', message: string) {
    super({ message, details: { code, status: 'skipped_opt_out' } });
  }
}
export const isWhatsAppSuppressed = (error: any): boolean =>
  ['WHATSAPP_OPTED_OUT', 'WHATSAPP_CONSENT_REQUIRED', 'WHATSAPP_WINDOW_CLOSED'].includes(error?.code);

export function enforcePreferencePolicy(statuses: Partial<Record<PreferenceScope, PreferenceStatus>>, marketing: boolean, support: boolean) {
  if (support && !marketing) return;
  if (statuses.all === 'opted_out' || (marketing && statuses.marketing === 'opted_out')) {
    throw new WhatsAppSuppressedError('WHATSAPP_OPTED_OUT', 'Recipient has opted out of this WhatsApp messaging scope');
  }
  if (marketing ? statuses.marketing !== 'opted_in' && statuses.all !== 'opted_in' : statuses.all !== 'opted_in') {
    throw new WhatsAppSuppressedError('WHATSAPP_CONSENT_REQUIRED', 'Explicit WhatsApp consent is required before business-initiated messaging');
  }
}
