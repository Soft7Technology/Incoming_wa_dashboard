import { Response, NextFunction } from 'express';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import HTTP403Error from '@surefy/exceptions/HTTP403Error';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import db from '@surefy/database';
import phoneNumberModel from '../../models/phoneNumber.model';

export function accountScope(req: JWTAuthRequest, _res: Response, next: NextFunction) {
  if (!req.companyId || !(req.ownerId ?? req.userId)) {
    return next(new HTTP403Error({ message: 'User and company context are required' }));
  }
  next();
}

export function ownedResource(table: 'contacts' | 'waba_accounts' | 'phone_numbers' | 'contact_lists' | 'contact_tags' | 'import_jobs', param: string) {
  return async (req: JWTAuthRequest, _res: Response, next: NextFunction) => {
    try {
      const ownerId = req.ownerId ?? req.userId;
      if (!ownerId || !req.companyId) throw new HTTP403Error({ message: 'User and company context are required' });
      const query = db(table).where({ id: req.params[param], user_id: ownerId, company_id: req.companyId }).whereNull('deleted_at');
      if (table === 'contacts' && req.userId !== ownerId) {
        query.whereRaw('assigned_to @> ARRAY[?]::uuid[]', [req.userId]);
      }
      if (!await query.first()) throw new HTTP404Error({ message: 'Resource not found in your account' });
      next();
    } catch (error) { next(error); }
  };
}

export async function ownedPhone(req: JWTAuthRequest, _res: Response, next: NextFunction) {
  try {
    const id = req.params.phoneNumberId ?? req.body?.phone_number_id;
    if (!id) return next();
    const phone = await phoneNumberModel.findByPhoneNumberId(id);
    if (!req.companyId || !(req.ownerId ?? req.userId) || !phone ||
        phone.user_id !== (req.ownerId ?? req.userId) || phone.company_id !== req.companyId) {
      throw new HTTP404Error({ message: 'Phone number not found in your account' });
    }
    // Contacts store the internal UUID, not the external Meta ID.
    if (req.body?.phone_number_id) req.body.phone_number_id = phone.id;
    next();
  } catch (error) { next(error); }
}

export async function accountAssignments(req: JWTAuthRequest, _res: Response, next: NextFunction) {
  try {
    const assigned = req.body?.assigned_to;
    if (assigned === undefined) return next();
    const ownerId = req.ownerId ?? req.userId;
    if (req.userId !== ownerId) throw new HTTP403Error({ message: 'Only the account owner can change contact assignments' });
    const ids = Array.isArray(assigned) ? assigned : [assigned];
    for (const id of ids) {
      if (id === ownerId) continue;
      const member = await db('users as u')
        .join('user_team as t', 't.email', 'u.email')
        .where({ 'u.id': id, 'u.company_id': req.companyId, 't.company_id': req.companyId,
          't.invite_sent_by': ownerId, 't.invite_status': 'accepted' })
        .whereNull('u.deleted_at').first();
      if (!member) throw new HTTP403Error({ message: 'Contact assignee must belong to your team' });
    }
    next();
  } catch (error) { next(error); }
}
