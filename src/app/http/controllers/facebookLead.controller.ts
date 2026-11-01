import { Response } from 'express';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { tryCatchAsync } from '@surefy/utils/Controller';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import facebookLeadService from '../../services/facebookLead.service';
import { uuidPattern } from '../../utils/facebook';


function readPositiveInteger(
  value: unknown,
  fallback: number,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined) return fallback;

  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new HTTP400Error({
      message: `${name} must be a positive integer.`,
    });
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new HTTP400Error({
      message: `${name} must be between 1 and ${maximum}.`,
    });
  }

  return parsed;
}

class FacebookLeadController {
    refreshForms = tryCatchAsync(
        async (req: JWTAuthRequest, res: Response) => {
            const { pageConnectionId } = req.params;

            if (
                typeof pageConnectionId !== 'string' ||
                !uuidPattern.test(pageConnectionId)
            ) {
                throw new HTTP400Error({
                    message: 'A valid pageConnectionId is required'
                })
            }

            if (!req.companyId || !req.userId) {
                throw new HTTP400Error({
                    message: 'Company and user context are required'
                })
            }

            const result = await facebookLeadService.refreshForms(
                pageConnectionId,
                {
                    companyId: req.companyId,
                    ownerId: req.ownerId || req.userId,
                    userId: req.userId,
                },
            );

            return res.status(200).json({
                success: true,
                data: result
            });
        },
    );

    listForms = tryCatchAsync(
        async (req: JWTAuthRequest, res: Response) => {
            const { pageConnectionId } = req.params;

            if (
                typeof pageConnectionId !== 'string' ||
                !uuidPattern.test(pageConnectionId)
            ) {
                throw new HTTP400Error({
                    message: 'A valid pageConnectionId is required'
                })
            }

            if (!req.companyId || !req.userId) {
                throw new HTTP400Error({
                    message: 'Company and user context are required'
                });
            }

            const result = await facebookLeadService.listForms(
                pageConnectionId,
                {
                    companyId: req.companyId,
                    ownerId: req.ownerId || req.userId,
                    userId: req.userId,
                }
            );

            return res.status(200).json({
                success: true,
                data: result,
            });
        },
    )

    updateForm = tryCatchAsync(
        async (req: JWTAuthRequest, res: Response) => {
            const { formConnectionId } = req.params;

            if (
                typeof formConnectionId !== 'string' ||
                !uuidPattern.test(formConnectionId)
            ) {
                throw new HTTP400Error({
                    message: 'A valid formConnectionId is required.',
                });
            }

            const body = req.body;

            if (
                !body ||
                typeof body !== 'object' ||
                Array.isArray(body) ||
                typeof body.enabled !== 'boolean' ||
                Object.keys(body).some((key) => key !== 'enabled')
            ) {
                throw new HTTP400Error({
                    message: 'Provide only "enabled" with a boolean value.',
                });
            }

            if (!req.companyId || !req.userId) {
                throw new HTTP400Error({
                    message: 'Company and user context are required.',
                });
            }

            const form = await facebookLeadService.updateForm(
                formConnectionId,
                body.enabled,
                {
                    companyId: req.companyId,
                    ownerId: req.ownerId || req.userId,
                    userId: req.userId,
                },
            );

            return res.status(200).json({
                success: true,
                data: form,
            });
        },
    );


    syncForm = tryCatchAsync(
        async (req: JWTAuthRequest, res: Response) => {
            const { formConnectionId } = req.params;

            if (
                typeof formConnectionId !== 'string' ||
                !uuidPattern.test(formConnectionId)
            ) {
                throw new HTTP400Error({
                    message: 'A valid formConnectionId is required.',
                });
            }

            if (!req.companyId || !req.userId) {
                throw new HTTP400Error({
                    message: 'Company and user context are required.',
                });
            }

            const result = await facebookLeadService.syncForm(
                formConnectionId,
                {
                    companyId: req.companyId,
                    ownerId: req.ownerId || req.userId,
                    userId: req.userId,
                },
            );

            return res.status(200).json({
                success: true,
                data: result,
            });
        },
    );

    listLeads = tryCatchAsync(
  async (req: JWTAuthRequest, res: Response) => {
    const { formConnectionId } = req.params;

    if (
      typeof formConnectionId !== 'string' ||
      !uuidPattern.test(formConnectionId)
    ) {
      throw new HTTP400Error({
        message: 'A valid formConnectionId is required.',
      });
    }

    if (!req.companyId || !req.userId) {
      throw new HTTP400Error({
        message: 'Company and user context are required.',
      });
    }

    const page = readPositiveInteger(req.query.page, 1, 'page');
    const limit = readPositiveInteger(req.query.limit, 25, 'limit', 100);

    if (!Number.isSafeInteger((page - 1) * limit)) {
      throw new HTTP400Error({
        message: 'The requested page is too large.',
      });
    }

    const result = await facebookLeadService.listLeads(
      formConnectionId,
      {
        companyId: req.companyId,
        ownerId: req.ownerId || req.userId,
        userId: req.userId,
      },
      { page, limit },
    );

    return res.status(200).json({
      success: true,
      data: result,
    });
  },
);

}

export default new FacebookLeadController();