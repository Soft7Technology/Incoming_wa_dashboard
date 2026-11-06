/** Shared dashboards intentionally serve users from multiple companies. Exact origins only. */
export const sharedDashboardOrigins: readonly string[] = ['https://app.soft7.in'];

/** Optional code-managed white-label dashboards. Use the company's internal UUID.
 * Active company_domains records are also supported, without a code deployment.
 * Example: { companyId: 'company-uuid', origin: 'https://dashboard.example.com' }
 */
export const companyDashboardOrigins: readonly { companyId: string; origin: string }[] = [];

/** Never enabled in production. Add your development tunnel here if needed. */
export const developmentDashboardOrigins: readonly string[] = [
  'http://localhost:3001',
  'http://127.0.0.1:3001',
  'https://waving-waving-albatross.ngrok-free.dev',
];
