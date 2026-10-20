import { Response } from 'express';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import pricing from '../../services/platformPricing.service';
import catalog from '../../services/planCatalog.service';

const actor = (req: JWTAuthRequest) => ({ userId: req.userId, companyId: req.companyId, userRole: req.userRole });

export default {
  get: tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    return successResponse(req, res, 'Platform fees', await pricing.get());
  }),
  update: tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'Platform fees updated', await pricing.update(actor(req), req.body))),
  charges: tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const [platform_fees, features, addons] = await Promise.all([pricing.get(), catalog.features(), catalog.addons(false, req.companyId)]);
    res.setHeader('Cache-Control', 'no-store');
    return successResponse(req, res, 'Current platform fees and add-on charges', {
      currency: 'INR', platform_fees, features, addons,
      platform_fee_applies_to: 'paid_plan_assignment_or_activation',
      addon_charge_type: 'one_time_until_plan_expiry',
    });
  }),
  allAddons: tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    return successResponse(req, res, 'Add-on catalog including inactive packs', await catalog.addons(true, undefined, true));
  }),
  updateAddon: tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'Add-on updated', await catalog.updateAddon(actor(req), req.params.id, req.body))),
};
