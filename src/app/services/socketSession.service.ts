import db from '@surefy/database';
import HTTP401Error from '@surefy/exceptions/HTTP401Error';

/** Origin is checked against the authenticated company, never used as an identity. */
export async function authorizeSocketOrigin(userId: string, companyId: string | undefined, origin: unknown) {
  let url: URL;
  try {
    if (typeof origin !== 'string') throw new Error();
    url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password || url.port) throw new Error();
  } catch {
    throw new HTTP401Error({ message: 'Socket origin is not allowed' });
  }
  const shared = (process.env.SOCKET_SHARED_ORIGINS || 'https://app.soft7.in').split(',').map(value => value.trim());
  if (!shared.includes(url.origin)) {
    if (!companyId) throw new HTTP401Error({ message: 'Socket origin is not allowed' });
    const domain = await db('company_domains').where({ company_id: companyId, status: 'active' })
      .whereIn('domain_name', [url.hostname, url.origin, `${url.origin}/`]).first('id');
    if (!domain) throw new HTTP401Error({ message: 'Socket origin is not allowed' });
  }
  return { userId, companyId: companyId || null };
}
