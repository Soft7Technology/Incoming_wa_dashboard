import type { Knex } from 'knex';
import db from '@surefy/database';
import { CustomError } from '@surefy/exceptions/CustomError';
import { sharedDashboardOrigins, companyDashboardOrigins, developmentDashboardOrigins } from '../../config/dashboardOrigins';

export class DashboardOriginError extends CustomError {
  constructor(message = 'This dashboard origin is not registered for your company.', status = 403) {
    super(message, status);
  }
}

export function parseDashboardOrigin(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    // Origin headers have no path, credentials, query or fragment. Do not normalize untrusted input.
    if (url.origin !== value || url.username || url.password ||
      (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' &&
        url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) return null;
    return url;
  } catch { return null; }
}

/** Without companyId this only authorizes CORS; OAuth start always checks JWT company ownership. */
export async function isDashboardOriginAllowed(value: unknown, companyId?: string, database: Knex = db): Promise<boolean> {
  const url = parseDashboardOrigin(value);
  if (!url) return false;
  if (sharedDashboardOrigins.includes(url.origin) || (process.env.NODE_ENV !== 'production' &&
    developmentDashboardOrigins.includes(url.origin))) return true;
  if (companyDashboardOrigins.some(entry => entry.origin === url.origin && (!companyId || entry.companyId === companyId))) return true;
  // DB records represent HTTPS hostnames, never arbitrary ports or HTTP origins.
  if (url.protocol !== 'https:' || url.port) return false;
  const query = database('company_domains')
    .where({ status: 'active', ssl_status: 'active' })
    .whereIn('domain_name', [url.hostname, url.origin, `${url.origin}/`]);
  if (companyId) query.where({ company_id: companyId });
  return Boolean(await query.first('id'));
}

export async function requireDashboardOrigin(value: unknown, companyId: string, database: Knex = db): Promise<string> {
  if (!companyId || !(await isDashboardOriginAllowed(value, companyId, database))) throw new DashboardOriginError();
  return value as string;
}

/** Callback destinations come exclusively from the claimed OAuth session, not callback parameters. */
export async function sessionDashboardOrigin(session: { frontend_origin?: string | null; company_id: string }, database: Knex = db) {
  if (!session.frontend_origin) throw new DashboardOriginError('This login predates the dashboard update. Connect again.', 409);
  return requireDashboardOrigin(session.frontend_origin, session.company_id, database);
}
