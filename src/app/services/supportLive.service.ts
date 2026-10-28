import { randomUUID } from 'node:crypto';
import { Knex } from 'knex';
import db from '@surefy/database';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP403Error from '@surefy/exceptions/HTTP403Error';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import { CustomError } from '@surefy/exceptions/CustomError';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import { SupportScope, supportObject, supportUuid, supportText, supportCursor, supportLimit, supportStatus } from '../utils/supportValidation';

type Connection = Knex | Knex.Transaction;
type Actor = { id: string; company_id: string; role: string; name: string; email: string; phone?: string; admin: boolean };
const conflict = (message: string) => new CustomError(message, HttpStatusCode.CONFLICT);

export class SupportLiveService {
  constructor(private readonly database: Knex = db) {}

  async actor(scope: SupportScope, connection: Connection = this.database): Promise<Actor> {
    if (!scope.userId || !scope.companyId) throw new HTTP403Error({ message: 'User and company context are required' });
    const user = await connection('users').where({ id: scope.userId, company_id: scope.companyId, status: 'active' })
      .whereNull('deleted_at').first('id', 'company_id', 'role', 'name', 'email', 'phone');
    const company = user && await connection('companies').where({ id: scope.companyId, status: 'active' })
      .whereNull('deleted_at').first('id');
    if (!user || !company) throw new HTTP403Error({ message: 'The support account is not active in this company' });
    return { ...user, admin: ['admin', 'company'].includes(user.role) };
  }

  private tickets(actor: Actor, connection: Connection = this.database) {
    const query = connection('support_tickets').where({ company_id: actor.company_id });
    if (!actor.admin) query.where({ user_id: actor.id });
    return query;
  }

  private async ticketFor(actor: Actor, id: string, connection: Connection = this.database, lock = false) {
    const query = this.tickets(actor, connection).where({ id });
    if (lock) query.forUpdate();
    const ticket = await query.first();
    if (!ticket) throw new HTTP404Error({ message: 'Ticket not found in your support account' });
    return ticket;
  }

  private async adminFor(actor: Actor, id: unknown, connection: Connection) {
    const admin = await connection('users').where({ id: supportUuid(id, 'admin_id'), company_id: actor.company_id, status: 'active' })
      // Compare text so legacy role labels absent from a native enum remain harmless.
      .whereRaw('??::text IN (?, ?)', ['role', 'admin', 'company']).whereNull('deleted_at').first('id');
    if (!admin) throw new HTTP400Error({ message: 'Select an active admin from your company' });
    return admin.id as string;
  }

  async admins(scope: SupportScope) {
    const actor = await this.actor(scope);
    return this.database('users').where({ company_id: actor.company_id, status: 'active' })
      .whereRaw('??::text IN (?, ?)', ['role', 'admin', 'company']).whereNull('deleted_at').select('id', 'name', 'email').orderBy('name').orderBy('id');
  }

  async list(scope: SupportScope, input: Record<string, unknown> = {}) {
    const actor = await this.actor(scope);
    const limit = supportLimit(input.limit, 20);
    const page = input.page === undefined ? 1 : Number(input.page);
    if (typeof input.page !== 'undefined' && (typeof input.page !== 'string' || !/^[1-9][0-9]{0,5}$/.test(input.page))) {
      throw new HTTP400Error({ message: 'page must be between 1 and 999999' });
    }
    const query = this.tickets(actor);
    if (input.status !== undefined) query.where({ status: supportStatus(input.status) });
    if (input.channel !== undefined) {
      if (typeof input.channel !== 'string' || !['ticket', 'live_chat'].includes(input.channel)) throw new HTTP400Error({ message: 'channel must be ticket or live_chat' });
      query.where({ channel: input.channel });
    }
    if (input.admin_id !== undefined) query.where({ assigned_admin_id: supportUuid(input.admin_id, 'admin_id') });
    const [count, items] = await Promise.all([
      query.clone().count('* as total').first(),
      query.clone().orderBy('updated_at', 'desc').orderBy('id').limit(limit).offset((page - 1) * limit),
    ]);
    return { items, pagination: { page, limit, total: Number(count?.total || 0) } };
  }

  async get(scope: SupportScope, id: unknown) {
    return this.ticketFor(await this.actor(scope), supportUuid(id));
  }

  async create(scope: SupportScope, input: unknown, defaultChannel = 'live_chat') {
    const body = supportObject(input);
    const message = supportText(body.message, 'message');
    const subject = body.subject === undefined ? message.split(/\r?\n/)[0].slice(0, 255) : supportText(body.subject, 'subject', 255);
    const channel = body.channel === undefined ? defaultChannel : body.channel;
    if (!['ticket', 'live_chat'].includes(channel)) throw new HTTP400Error({ message: 'channel must be ticket or live_chat' });
    const requestId = body.client_request_id === undefined ? null : supportUuid(body.client_request_id, 'client_request_id');
    return this.database.transaction(async connection => {
      const actor = await this.actor(scope, connection);
      const adminId = body.admin_id == null ? null : await this.adminFor(actor, body.admin_id, connection);
      const name = body.name === undefined ? actor.name : supportText(body.name, 'name', 255);
      const email = body.email === undefined ? actor.email : supportText(body.email, 'email', 255);
      if (!name || !email) throw new HTTP400Error({ message: 'The support profile requires a name and email' });
      const [ticket] = await connection('support_tickets').insert({
        id: randomUUID(), user_id: actor.id, company_id: actor.company_id, name, email,
        phone: body.phone === undefined ? actor.phone || null : supportText(body.phone, 'phone', 50),
        message, subject, channel, assigned_admin_id: adminId, client_request_id: requestId,
        status: 'open', created_at: connection.fn.now(), updated_at: connection.fn.now(),
      }).onConflict(['company_id', 'user_id', 'client_request_id']).ignore().returning('*');
      if (!ticket) {
        const existing = await connection('support_tickets').where({ company_id: actor.company_id, user_id: actor.id, client_request_id: requestId }).first();
        if (!existing || existing.message !== message || existing.subject !== subject || existing.channel !== channel) {
          throw conflict('client_request_id was already used for a different ticket');
        }
        return existing;
      }
      await connection('ticket_conversation').insert({
        id: randomUUID(), ticket_id: ticket.id, company_id: actor.company_id, user_id: actor.id,
        user_name: actor.name, user_email: actor.email, user_phone: actor.phone || null, message,
      });
      return ticket;
    });
  }

  async messages(scope: SupportScope, id: unknown, input: Record<string, unknown> = {}) {
    const actor = await this.actor(scope);
    const ticket = await this.ticketFor(actor, supportUuid(id));
    const limit = supportLimit(input.limit);
    if (input.after !== undefined && input.before !== undefined) throw new HTTP400Error({ message: 'Use either after or before' });
    const ascending = input.after !== undefined;
    const query = this.database('ticket_conversation as m').leftJoin('users as u', 'm.user_id', 'u.id')
      .where({ 'm.ticket_id': ticket.id, 'm.company_id': actor.company_id })
      .select('m.*', 'u.role as sender_role');
    if (input.after !== undefined) query.where('m.sequence', '>', supportCursor(input.after));
    if (input.before !== undefined) query.where('m.sequence', '<', supportCursor(input.before));
    const rows = await query.orderBy('m.sequence', ascending ? 'asc' : 'desc').limit(limit + 1);
    const items = rows.slice(0, limit);
    if (!ascending) items.reverse();
    return { items, has_more: rows.length > limit, next_cursor: items.length ? String(items[items.length - 1].sequence) : null,
      previous_cursor: items.length ? String(items[0].sequence) : null };
  }

  async reply(scope: SupportScope, id: unknown, input: unknown) {
    const ticketId = supportUuid(id);
    const body = supportObject(input);
    const message = supportText(body.message, 'message');
    const clientId = body.client_message_id === undefined ? null : supportUuid(body.client_message_id, 'client_message_id');
    return this.database.transaction(async connection => {
      const actor = await this.actor(scope, connection);
      const ticket = await this.ticketFor(actor, ticketId, connection, true);
      if (clientId) {
        const existing = await connection('ticket_conversation').where({ ticket_id: ticket.id, user_id: actor.id, client_message_id: clientId }).first();
        if (existing) {
          if (existing.message !== message) throw conflict('client_message_id was already used for a different message');
          return { ...existing, sender_role: actor.role };
        }
      }
      if (['closed', 'resolved'].includes(ticket.status)) throw conflict('Reopen this ticket before sending a message');
      if (actor.admin && ticket.assigned_admin_id && ticket.assigned_admin_id !== actor.id) throw conflict('This ticket is assigned to another admin');
      const [reply] = await connection('ticket_conversation').insert({
        id: randomUUID(), ticket_id: ticket.id, company_id: ticket.company_id, user_id: actor.id,
        user_name: actor.name, user_email: actor.email, user_phone: actor.phone || null,
        message, client_message_id: clientId, forward_by: ticket.forward_by, forward_superadmin: ticket.forward_superadmin,
      }).returning('*');
      await connection('support_tickets').where({ id: ticket.id }).update({ updated_at: connection.fn.now() });
      return { ...reply, sender_role: actor.role };
    });
  }

  async join(scope: SupportScope, id: unknown) {
    return this.database.transaction(async connection => {
      const actor = await this.actor(scope, connection);
      if (!actor.admin) throw new HTTP403Error({ message: 'Only company admins can join as support agents' });
      const ticket = await this.ticketFor(actor, supportUuid(id), connection, true);
      if (['closed', 'resolved'].includes(ticket.status)) throw conflict('Reopen this ticket before joining');
      if (ticket.assigned_admin_id && ticket.assigned_admin_id !== actor.id) throw conflict('This ticket is assigned to another admin');
      const [updated] = await connection('support_tickets').where({ id: ticket.id }).update({
        assigned_admin_id: actor.id, status: 'in_progress', channel: 'live_chat', updated_at: connection.fn.now(),
      }).returning('*');
      return updated;
    });
  }

  async assign(scope: SupportScope, id: unknown, input: unknown) {
    const body = supportObject(input);
    if (!Object.prototype.hasOwnProperty.call(body, 'admin_id')) throw new HTTP400Error({ message: 'admin_id is required; use null to unassign' });
    return this.database.transaction(async connection => {
      const actor = await this.actor(scope, connection);
      if (!actor.admin) throw new HTTP403Error({ message: 'Only company admins can reassign tickets' });
      const ticket = await this.ticketFor(actor, supportUuid(id), connection, true);
      const adminId = body.admin_id === null ? null : await this.adminFor(actor, body.admin_id, connection);
      const [updated] = await connection('support_tickets').where({ id: ticket.id })
        .update({ assigned_admin_id: adminId, updated_at: connection.fn.now() }).returning('*');
      return updated;
    });
  }

  async status(scope: SupportScope, id: unknown, value: unknown) {
    const status = supportStatus(value);
    return this.database.transaction(async connection => {
      const actor = await this.actor(scope, connection);
      if (status === 'in_progress' && !actor.admin) throw new HTTP403Error({ message: 'Only an admin can mark a ticket in progress' });
      const ticket = await this.ticketFor(actor, supportUuid(id), connection, true);
      if (ticket.status === 'closed' && !['closed', 'open'].includes(status)) throw conflict('Reopen this ticket first');
      const [updated] = await connection('support_tickets').where({ id: ticket.id })
        .update({ status, updated_at: connection.fn.now() }).returning('*');
      return updated;
    });
  }

  async remove(scope: SupportScope, id: unknown) {
    return this.database.transaction(async connection => {
      const actor = await this.actor(scope, connection);
      if (!actor.admin) throw new HTTP403Error({ message: 'Only company admins can delete tickets' });
      const ticket = await this.ticketFor(actor, supportUuid(id), connection, true);
      await connection('support_tickets').where({ id: ticket.id }).delete();
      return { id: ticket.id };
    });
  }

  private eventQuery(actor: Actor, ticketId?: string) {
    const query = this.database('support_ticket_events').where({ company_id: actor.company_id });
    if (!actor.admin) query.where({ owner_id: actor.id });
    if (ticketId) query.where({ ticket_id: ticketId });
    return query;
  }

  async events(scope: SupportScope, after: string, ticketId?: string) {
    const actor = await this.actor(scope);
    return this.eventQuery(actor, ticketId).where('id', '>', supportCursor(after)).orderBy('id').limit(100);
  }

  async eventCursor(scope: SupportScope, ticketId?: string) {
    const actor = await this.actor(scope);
    if (ticketId) await this.ticketFor(actor, supportUuid(ticketId));
    const row = await this.eventQuery(actor, ticketId).max('id as cursor').first();
    return String(row?.cursor || '0');
  }
}

export default new SupportLiveService();
