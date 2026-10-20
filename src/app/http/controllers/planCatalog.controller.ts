import { Response } from 'express';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import catalog from '../../services/planCatalog.service';
import addons from '../../services/planAddon.service';
import usage from '../../services/planUsage.service';
import HTTP403Error from '@surefy/exceptions/HTTP403Error';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import db from '@surefy/database';
import { ALLOWED_TRIAL_DAYS, DEFAULT_TRIAL_DAYS, freeTrialFeatures } from '../../utils/freeTrialPolicy';
import { subscriptionPlanOptions } from '../../utils/subscriptionPlanNames';
import companyAddons from '../../services/companyAddon.service';

const actor = (req: JWTAuthRequest) => ({ userId: req.userId, companyId: req.companyId, userRole: req.userRole });
export default {
  planOptions: tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'Subscription plan options', subscriptionPlanOptions())),
  trialPolicy: tryCatchAsync(async (req: JWTAuthRequest, res: Response) => successResponse(req, res, 'Fixed free trial policy', {
    plan_name: 'Free', billing_cycle: 'Free', price: 0, default_trial_days: DEFAULT_TRIAL_DAYS,
    allowed_trial_days: ALLOWED_TRIAL_DAYS, features_locked: true, features: freeTrialFeatures(),
  })),
  features: tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'Feature catalog', await catalog.features()),
  ),
  createFeature: tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'Feature created', await catalog.createFeature(actor(req), req.body)),
  ),
  addons: tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'Available add-ons', await catalog.planAddons(actor(req), req.query.plan_id === undefined ? undefined : String(req.query.plan_id), req.query.include_inactive === 'true')),
  ),
  createAddon: tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'Add-on created', req.userRole === 'superadmin'
      ? await catalog.createAddon(actor(req), req.body) : await companyAddons.create(actor(req), req.body)),
  ),
  updateCompanyAddon: tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'Company add-on updated', await companyAddons.update(actor(req), req.params.id, req.body))),
  disableAddon: tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'Add-on disabled', req.userRole === 'superadmin'
      ? await catalog.disableAddon(actor(req), req.params.id) : await companyAddons.update(actor(req), req.params.id, { active: false })),
  ),
  purchase: tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(
      req,
      res,
      'Add-on purchased from company wallet',
      await addons.purchase(actor(req), req.body, req.get('Idempotency-Key')),
    ),
  ),
  entitlements: tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const owner = req.ownerId ?? req.userId!;
    const userId = req.query.user_id === undefined ? owner : String(req.query.user_id);
    if (userId !== owner) {
      if (!['admin', 'company', 'superadmin'].includes(req.userRole || '') || !req.companyId)
        throw new HTTP403Error({ message: 'Company administrator required' });
      const user = await db('users').where({ id: userId, company_id: req.companyId }).whereNull('deleted_at').first();
      if (!user) throw new HTTP404Error({ message: 'User not found in your company' });
    }
    return successResponse(req, res, 'Current plan entitlements', await usage.summary(userId));
  }),
};
