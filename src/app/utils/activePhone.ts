import HTTP403Error from '@surefy/exceptions/HTTP403Error';

/** Check the current sender at creation and dispatch; campaign workers refresh it between batches. */
export function assertActivePhone(phone: { active?: boolean; connection_status?: string }) {
  if (phone.connection_status && !['legacy', 'connected'].includes(phone.connection_status)) throw new HTTP403Error({
    message: 'This WhatsApp number has not finished connecting. Check its onboarding status before sending.',
    details: { code: 'WABA_NUMBER_NOT_CONNECTED', feature: 'WabaNumber', required_action: 'COMPLETE_WABA_ONBOARDING' },
  });
  if (phone.active === false) throw new HTTP403Error({
    message: 'This WABA number is inactive. Activate it within your plan allowance or purchase a WABA number add-on.',
    details: { code: 'WABA_NUMBER_INACTIVE', feature: 'WabaNumber', required_action: 'ACTIVATE_WABA_NUMBER' },
  });
}
