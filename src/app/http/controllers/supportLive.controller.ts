import { Response } from 'express';
import jwt from 'jsonwebtoken';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { CustomError } from '@surefy/exceptions/CustomError';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import service from '../../services/supportLive.service';
import { supportEventHub } from '../../services/supportEventHub';
import { supportCursor, supportUuid } from '../../utils/supportValidation';

const scope = (req: JWTAuthRequest) => ({ userId: req.userId, companyId: req.companyId });
const streamsPerUser = new Map<string, number>();
const streams = new Set<() => void>();

export function closeSupportStreams() { for (const close of streams) close(); }

class SupportLiveController {
  admins = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'Company support admins retrieved', await service.admins(scope(req))));
  list = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'Support tickets retrieved', await service.list(scope(req), req.query)));
  create = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'Live support ticket created', await service.create(scope(req), req.body), HttpStatusCode.CREATED));
  get = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'Support ticket retrieved', await service.get(scope(req), req.params.ticketId)));
  messages = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'Support messages retrieved', await service.messages(scope(req), req.params.ticketId, req.query)));
  reply = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'Message saved', await service.reply(scope(req), req.params.ticketId, req.body)));
  join = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'Admin joined the live conversation', await service.join(scope(req), req.params.ticketId)));
  assign = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'Support assignment updated', await service.assign(scope(req), req.params.ticketId, req.body)));
  status = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'Ticket status updated', await service.status(scope(req), req.params.ticketId, req.body?.status)));

  events = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const account = scope(req);
    const actor = await service.actor(account);
    const ticketId = req.query.ticket_id === undefined ? undefined : supportUuid(req.query.ticket_id, 'ticket_id');
    // Validate ticket access even when the caller supplies its own replay cursor.
    const latest = await service.eventCursor(account, ticketId);
    const supplied = req.headers['last-event-id'] ?? req.query.after;
    let cursor = supplied === undefined ? latest : supportCursor(supplied);
    if (res.destroyed || res.writableEnded) return;
    const key = `${actor.company_id}:${actor.id}`;
    if ((streamsPerUser.get(key) || 0) >= 5) throw new CustomError('At most five live support streams per user per API instance', HttpStatusCode.TOO_MANY_REQUESTS);
    streamsPerUser.set(key, (streamsPerUser.get(key) || 0) + 1);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    let closed = false, running = false, pending = false;
    let poll: NodeJS.Timeout, heartbeat: NodeJS.Timeout, expiry: NodeJS.Timeout;
    let unsubscribe = () => {};
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(poll); clearInterval(heartbeat); clearTimeout(expiry); unsubscribe();
      streams.delete(close);
      const remaining = (streamsPerUser.get(key) || 1) - 1;
      if (remaining) streamsPerUser.set(key, remaining); else streamsPerUser.delete(key);
      res.end();
    };
    const send = (event: string, data: unknown, id?: string) => {
      if (closed) return false;
      const writable = res.write(`${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      (res as Response & { flush?: () => void }).flush?.();
      if (!writable) close(); // A reconnect can replay; never buffer an unbounded slow client.
      return writable;
    };
    const catchUp = async () => {
      if (closed) return;
      if (running) { pending = true; return; }
      running = true;
      try {
        do {
          pending = false;
          const events = await service.events(account, cursor, ticketId);
          if (closed) break;
          for (const event of events) {
            if (!send(event.type, { ...event.data, event_id: String(event.id), created_at: event.created_at }, String(event.id))) break;
            cursor = String(event.id);
          }
          if (events.length === 100) pending = true;
        } while (pending && !closed);
      } catch (error) {
        const code = (error as { statusCode?: number }).statusCode;
        send('stream.error', { code: code === 403 ? 'ACCESS_REVOKED' : 'TEMPORARILY_UNAVAILABLE', reconnect: code !== 403 });
        close();
      } finally { running = false; }
    };
    streams.add(close);
    res.once('close', close);
    unsubscribe = supportEventHub.subscribe(actor.company_id, () => { void catchUp(); });
    // Polling is a durability fallback for lost LISTEN notifications or listener reconnects.
    poll = setInterval(() => { void catchUp(); }, 5000); poll.unref();
    heartbeat = setInterval(() => { if (!res.write(': heartbeat\n\n')) close(); }, 15000); heartbeat.unref();
    const decoded = jwt.decode((req.headers.authorization || '').slice(7)) as { exp?: number } | null;
    const lifetime = Math.min(15 * 60 * 1000, decoded?.exp ? Math.max(0, decoded.exp * 1000 - Date.now()) : 15 * 60 * 1000);
    expiry = setTimeout(() => { send('stream.reconnect', { reason: 'REFRESH_AUTHENTICATION' }); close(); }, lifetime); expiry.unref();
    send('ready', { cursor, heartbeat_ms: 15000 }, cursor);
    void catchUp();
  });
}

export default new SupportLiveController();
