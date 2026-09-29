import { AsyncLocalStorage } from 'node:async_hooks';

export interface ActivityContext {
  userId: string;
  companyId?: string;
  recorded: boolean;
  request_method: string;
  api_endpoint: string;
  ip_address: string;
  user_agent: string;
}
// AsyncLocalStorage isolates actor metadata and deduplication across concurrent requests.
export const activityContext = new AsyncLocalStorage<ActivityContext>();
export function markActivityRecorded() {
  const context = activityContext.getStore();
  if (context) context.recorded = true;
}
