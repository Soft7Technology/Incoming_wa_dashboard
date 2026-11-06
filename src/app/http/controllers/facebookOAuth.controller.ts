import { Request, Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import CreditService from '@surefy/console/services/credit.service';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { AuthRequest } from '@surefy/middleware/auth.middleware';
import facebookOAuthService, { FacebookFeature, } from '../../services/facebookOAuth.service';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { facebookCredentials } from '../../utils/facebook';
import { requireDashboardOrigin } from '../../services/dashboardOrigin.service';


function getFeature(value: unknown): FacebookFeature {
    if (value === 'leads' || value === 'messaging') {
        return value;
    }

    throw new HTTP400Error({
        message: 'feature must be either "leads" or "messaging".',
    });
}

class facebookOAuthController {
    /*
   GET /v1/admin/facebook/setup?feature=leads
   GET /v1/admin/facebook/setup?feature=messaging
  */
    setup = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
        const feature = getFeature(req.query.feature)
        if (req.headers.origin) await requireDashboardOrigin(req.headers.origin, req.companyId!);
        const result = await facebookOAuthService.setup(feature)

        return res.status(200).json({
            success: true,
            data: result
        })
    });

    /*
   POST /v1/admin/facebook/oauth/start

   Body:
   {
     "feature": "leads"
   }
  */
    start = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
        const feature = getFeature(req.body?.feature);

        if (!req.companyId || !req.userId) {
            throw new HTTP400Error({
                message: 'Company and user context are required.',
            });
        }

        const result = await facebookOAuthService.start(feature, {
            companyId: req.companyId,
            ownerId: req.ownerId || req.userId,
            userId: req.userId,
        }, req.headers.origin);

        const secureCookie =
            process.env.FACEBOOK_PUBLIC_URL?.startsWith('https://') ?? false;

        res.cookie(result.cookieName, result.browser, {
            httpOnly: true,
            secure: secureCookie,
            sameSite: secureCookie ? 'none' : 'lax',
            path: '/v1',
            maxAge: 15 * 60 * 1000,
        });

        return res.status(200).json({
            success: true,
            data: {
                authorization_url: result.authorizationUrl,
                expires_at: result.expiresAt.toISOString(),
            },
        });
    });


    pages = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
        const feature = getFeature(req.query.feature)

        if (!req.companyId || !req.userId) {
            throw new HTTP400Error({
                message: 'Company and user context are required'
            })
        }

        const result = await facebookOAuthService.pages(
            feature,
            {
                companyId: req.companyId,
                ownerId: req.ownerId || req.userId,
                userId: req.userId
            },
            req.headers.cookie
        );

        return res.status(200).json({
            success: true,
            data: result,
        });
    })

    leadsCallback = tryCatchAsync(
        async (req: Request, res: Response) => {
            res.set('Cache-Control', 'no-store');
            res.set('Referrer-Policy', 'no-referrer');

            const redirectUrl = await facebookOAuthService.leadsCallback({
                state: req.query.state,
                code: req.query.code,
                denied: req.query.error !== undefined,
                cookieHeader: req.headers.cookie,
            });

            // Keep the browser cookie: /oauth/pages and POST /pages still need it.
            return res.redirect(303, redirectUrl);
        },
    );

    messagingCallback = tryCatchAsync(
        async(req: JWTAuthRequest,res: Response)=>{
            res.set('Cache-Control', 'no-store');
            res.set('Referre-Policy', 'no-referrer');

            const redirectUrl = await facebookOAuthService.messagingCallback({
                state: req.query.state,
                code: req.query.code,
                denied: req.query.error !== undefined,
                cookieHeader: req.headers.cookie,
            });

            // Keep the browser cookie for Page selection and connection.
            return res.redirect(303, redirectUrl);
        }
    )

}

export default new facebookOAuthController();
