import db from '@surefy/database';
import type { FacebookFeature } from '../services/facebookOAuth.service';

type FindInput = {
   feature: FacebookFeature;
   companyId:string;
   ownerId:string;
   browerHash:string; 
}

type CallbackResult = {
  status: 'ready' | 'failed';
  facebookUserId?: string;
  candidatesCiphertext?: string;
  error?: string;
};

class FacebookOauthSessionModel{
    private table(feature:FacebookFeature){
        return feature === 'leads'
          ? 'facebook_lead_oauth_sessions'
          : 'facebook_oauth_sessions';
    }

    async claimCallback(
  feature: FacebookFeature,
  stateHash: string,
  browserHash: string,
) {
  // Only one request can move this session from started to authorizing.
  const [session] = await db(this.table(feature))
    .where({
      state_hash: stateHash,
      browser_hash: browserHash,
      status: 'started',
    })
    .where('expires_at', '>', new Date())
    .update({
      status: 'authorizing',
      error: null,
    })
    .returning(['state_hash', 'company_id', 'owner_id', 'frontend_origin']);

  return session;
}

async finishCallback(
  feature: FacebookFeature,
  stateHash: string,
  browserHash: string,
  result: CallbackResult,
): Promise<boolean> {
  const [session] = await db(this.table(feature))
    .where({
      state_hash: stateHash,
      browser_hash: browserHash,
      status: 'authorizing',
    })
    .where('expires_at', '>', new Date())
    .update({
      status: result.status,
      facebook_user_id: result.facebookUserId ?? null,
      candidates_ciphertext: result.candidatesCiphertext ?? null,
      error: result.error ?? null,
    })
    .returning('state_hash');

  // A disconnect, new login, or expiry may have invalidated the session.
  return Boolean(session);
}

    async findActive(input:FindInput){
        return db(this.table(input.feature))
         .where({
            company_id:input.companyId,
            owner_id:input.ownerId,
            browser_hash:input.browerHash,
         })
         .where('expires_at','>', new Date())
         .first()
    }
}

export default new FacebookOauthSessionModel();
