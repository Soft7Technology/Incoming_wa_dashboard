import HTTP403Error from '@surefy/exceptions/HTTP403Error';
import type { FacebookFeature } from './facebookOAuth.service';
import facebookPageModel from '../models/facebookPage.model'
import db from '@surefy/database';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { CustomError } from '@surefy/exceptions/CustomError';
import { hash, decrypt, encrypt } from '../utils/facebook';
import facebookLeadSubscriptionService from './facebookLeadSubscription.service';

type PageScope = {
    companyId: string;
    ownerId: string;
    userId: string;
};

class FacebookPageService {
    async list(feature: FacebookFeature, scope: PageScope) {
        if (scope.userId !== scope.ownerId) {
            throw new HTTP403Error({
                message: 'Only account owner can view Facebook connections.'
            })
        }

        return facebookPageModel.findAllByScope(
            feature,
            scope.companyId,
            scope.ownerId
        )
    }

    async connect(
        feature: FacebookFeature,
        pageId: string,
        scope: PageScope,
        cookieHeader: string | undefined,
    ) {
        if (scope.userId !== scope.ownerId) {
            throw new HTTP403Error({
                message: 'Only the account owner can connect facebook'
            });
        }

        const cookieName = feature === 'leads' ? 'fb_lead_browser' : 'fb_messaging_browser'
        const browser = cookieHeader
            ?.split(';')
            .map((part) => part.trim())
            .find((part) => part.startsWith(`${cookieName}=`))
            ?.slice(cookieName.length + 1);

        if (!browser || !/^[A-Za-z0-9_-]{43}$/.test(browser)) {
            throw new HTTP400Error({
                message: 'Start Facebook authorization in this browser first.',
            });
        }

        const reservation = await db.transaction(async (trx) => {
            const session = await facebookPageModel.lockSession(
                trx,
                feature,
                scope.companyId,
                scope.ownerId,
                hash(browser)
            );

            if (
                !session ||
                new Date(session.expires_at).getTime() <= Date.now() ||
                session.status !== 'ready' ||
                !session.candidates_ciphertext
            ) {
                throw new CustomError(
                    'Facebook authorization is unavailable or expired. Connect again.',
                    409,
                    true,
                );
            }

            // Expected callback payload:
            // { pages: [{ id, name, access_token }] }
            const candidates = JSON.parse(decrypt(session.candidates_ciphertext));

            const selectedPage = Array.isArray(candidates.pages)
              ? candidates.pages.find((page:any)=>String(page.id) === pageId)
              : undefined

            if(!selectedPage){
                throw new HTTP400Error({
                    message: 'Select a Page returned by ths facebook authorization',   
                })
            }

            if(
                typeof selectedPage.name !== 'string' ||
                typeof selectedPage.access_token !== 'string' ||
                !selectedPage.access_token ||
                !session.facebook_user_id
            ){
                throw new CustomError(
        'Facebook authorization is incomplete. Connect again.',
        409,
        true,
                )
            }

            const dataExpires = candidates.dataExpires ? new Date(candidates.dataExpires) : null;
            if (dataExpires && (!Number.isFinite(dataExpires.getTime()) || dataExpires.getTime() <= Date.now())) {
                throw new CustomError('Facebook data access has expired. Connect again.', 409);
            }
            const tokenCiphertext = encrypt(selectedPage.access_token);
            const result = await facebookPageModel.saveSelectedPage(
                trx,
                feature,
                {
                    company_id:scope.companyId,
                    owner_id:scope.ownerId,
                    page_id:pageId,
                    name:selectedPage.name,
                    facebook_user_id:session.facebook_user_id,
                    token_ciphertext: tokenCiphertext,
                    data_access_expires_at: dataExpires,
                }
            )

            // Keep the session ready until Meta confirms the Page subscription.
            return { result, stateHash: session.state_hash, tokenCiphertext, token: selectedPage.access_token as string };
        });


        try {
            // Never hold database locks while waiting for Meta.
            await facebookLeadSubscriptionService.ensureSubscribed(pageId, reservation.token, feature);

            return await db.transaction(async (trx) => {
                const session = await facebookPageModel.lockSession(
                    trx, feature, scope.companyId, scope.ownerId, hash(browser),
                );
                if (!session || session.status !== 'ready' || session.state_hash !== reservation.stateHash ||
                    new Date(session.expires_at).getTime() <= Date.now()) {
                    throw new CustomError('Facebook authorization changed or expired. Connect again.', 409);
                }
                const page = await facebookPageModel.markConnected(
                    trx, feature, reservation.result.page.id, scope.companyId, scope.ownerId, reservation.tokenCiphertext,
                );
                if (!page) {
                    throw new CustomError('The Page connection changed. Retry connecting the Page.', 409);
                }
                await facebookPageModel.completeSession(trx, feature, session.state_hash);
                return { created: reservation.result.created, page };
            });
        } catch (error: unknown) {
            const message = error instanceof CustomError
                ? error.message
                : 'Facebook Page connection could not be completed. Retry connecting the Page.';
            await facebookPageModel.recordSubscriptionError(
                feature, reservation.result.page.id, scope.companyId, scope.ownerId, reservation.tokenCiphertext, message,
            );
            throw error;
        }

    }

    async disconnect(
  feature: FacebookFeature,
  pageConnectionId: string,
  scope: PageScope,
) {
  if (scope.userId !== scope.ownerId) {
    throw new HTTP403Error({
      message: 'Only the account owner can disconnect Facebook Pages.',
    });
  }

  return db.transaction(async (trx) => {
    // Match the connection flow's lock order: sessions before Page.
    await facebookPageModel.cancelOAuthSessions(
      trx,
      feature,
      scope.companyId,
      scope.ownerId,
    );

    const page = await facebookPageModel.disconnectByScope(
      trx,
      feature,
      pageConnectionId,
      scope.companyId,
      scope.ownerId,
    );

    if (!page) {
      // Throwing also rolls back the session deletion.
      throw new CustomError(
        'Facebook Page connection not found.',
        404,
      );
    }

    if (feature === 'leads') {
      await facebookPageModel.disableLeadForms(
        trx,
        pageConnectionId,
      );
    }

    return {
      page_connection_id: page.id,
      feature,
      status: page.status,
    };
  });
}

}

export default new FacebookPageService();
