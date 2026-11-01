import { Request, Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import CreditService from '@surefy/console/services/credit.service';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { AuthRequest } from '@surefy/middleware/auth.middleware';
import facebookOAuthService, { FacebookFeature, } from '../../services/facebookOAuth.service';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import facebookPageService from '../../services/facebookPage.service';
import { uuidPattern } from '../../utils/facebook';
import { tryCatch } from 'bullmq';

class facebookPageController{
    list= tryCatchAsync(async(req:JWTAuthRequest,res:Response)=>{
        const feature = req.query.feature;

        if(feature !== 'leads' && feature !== 'messaging'){
            throw new HTTP400Error({
                message: 'Feature must be either "leads" or "messaging"' 
            });
        }

        if(!req.companyId || !req.userId){
            throw new HTTP400Error({
                message: 'Company and user context are required'
            })
        }

        const pages = await facebookPageService.list(feature,{
            companyId:req.companyId,
            ownerId:req.ownerId || req.userId,
            userId:req.userId
        });

        return res.status(200).json({
            success:true,
            data:pages
        });
    })

    disconnect = tryCatchAsync(
  async (req: JWTAuthRequest, res: Response) => {
    const { pageConnectionId } = req.params;
    const feature = req.query.feature;

    if (
      typeof pageConnectionId !== 'string' ||
      !uuidPattern.test(pageConnectionId)
    ) {
      throw new HTTP400Error({
        message: 'A valid pageConnectionId is required.',
      });
    }

    if (feature !== 'leads' && feature !== 'messaging') {
      throw new HTTP400Error({
        message: 'feature must be either "leads" or "messaging".',
      });
    }

    if (!req.companyId || !req.userId) {
      throw new HTTP400Error({
        message: 'Company and user context are required.',
      });
    }

    const result = await facebookPageService.disconnect(
      feature,
      pageConnectionId,
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

    connect = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
        const { feature, page_id } = req.body ?? {};

        if (feature !== 'leads' && feature !== 'messaging') {
            throw new HTTP400Error({
                message: 'Feature must be either "leads" or "messaging"'
            });
        }

        if (typeof page_id !== 'string' || !/^\d{1,80}$/.test(page_id)) {
            throw new HTTP400Error({
                message: 'page_id must be a numeric string.',
            });
        }

        if(!req.companyId || !req.userId){
            throw new HTTP400Error({
                message:'Company and user context are required',
            });
        }

        const result = await facebookPageService.connect(
            feature,
            page_id,
            {
                companyId:req.companyId,
                ownerId:req.ownerId || req.userId,
                userId:req.userId,
            },
            req.headers.cookie
        );

        return res.status(result.created ? 201: 200).json({
            success:true,
            data:result.page,
        });
    })
}

export default new facebookPageController();