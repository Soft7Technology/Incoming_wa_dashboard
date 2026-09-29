import { Request, Response, NextFunction } from 'express';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { validateCampaignPhoneInputs } from '../../utils/campaignPhone';

export function validateCampaignPhones(req: Request, _res: Response, next: NextFunction) {
  try { validateCampaignPhoneInputs(req.body?.contact_filters, req.body?.country_code); next(); }
  catch (error: any) { next(new HTTP400Error({ message: error.message })); }
}
