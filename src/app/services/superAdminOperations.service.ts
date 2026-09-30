import model from '../models/superAdminOperations.model';
import { ReportResource, OperationsFilters } from '../interfaces/superAdminOperations.interface';
import * as v from '../utils/superAdminValidation';

class SuperAdminOperationsService {
  private filters(query: Record<string, unknown>, resource: string): OperationsFilters {
    const { forwarded, assigned_to, ...rest } = query;
    const filters: OperationsFilters = v.filters(rest);
    v.requireInput(!filters.domain_status, 'domain_status does not apply to this report');
    if (resource === 'tickets') {
      if (forwarded !== undefined) {
        v.requireInput(forwarded === 'true' || forwarded === 'false', 'forwarded must be true or false');
        filters.forwarded = forwarded === 'true';
      }
      if (assigned_to !== undefined) filters.assigned_to = v.uuid(assigned_to, 'assigned_to');
    } else
      v.requireInput(
        forwarded === undefined && assigned_to === undefined,
        'Ticket filters do not apply to this report',
      );
    if (['plans', 'revenue', 'company_revenue'].includes(resource))
      v.requireInput(!filters.status, 'status is not supported for this report');
    if (['tickets', 'payments', 'revenue'].includes(resource))
      v.requireInput(!filters.search, 'search is not supported for this report');
    return filters;
  }
  overview(query: Record<string, unknown>) {
    return model.subscriptionOverview(this.filters(query, 'revenue'));
  }
  revenue(query: Record<string, unknown>, byCompany = false) {
    return model.revenue(this.filters(query, byCompany ? 'company_revenue' : 'revenue'), byCompany);
  }
  list(resource: ReportResource, query: Record<string, unknown>) {
    return model.list(resource, this.filters(query, resource));
  }
  conversation(id: string, query: Record<string, unknown>) {
    v.allowed(query, ['page', 'limit']);
    return model.conversation(v.uuid(id, 'ticketId'), v.filters(query));
  }
  async escalate(actor: string, companyId: string | undefined, role: string | undefined, id: string, body: unknown) {
    const ticket = await model.ticket(v.uuid(id, 'ticketId'));
    v.requireInput(
      companyId &&
        ticket.company_id === companyId &&
        (['admin', 'company'].includes(role || '') || ticket.user_id === actor),
      'Ticket is not accessible in your account',
    );
    return this.changeTicket(actor, id, 'forward', body);
  }
  changeTicket(actor: string, id: string, action: 'forward' | 'reply' | 'status', body: unknown) {
    v.uuid(id, 'ticketId');
    const data = v.object(body);
    const field = action === 'forward' ? 'superadmin_id' : action === 'reply' ? 'message' : 'status';
    v.allowed(data, [field, 'reason']);
    const value =
      action === 'forward' ? v.uuid(data[field], field) : v.text(data[field], field, action === 'reply' ? 10000 : 30);
    if (action === 'status')
      v.requireInput(['open', 'resolved', 'closed'].includes(value), 'status must be open, resolved or closed');
    return model.changeTicket(actor, id, action, value, v.text(data.reason, 'reason', 1000));
  }
}
export default new SuperAdminOperationsService();
