import { EventEmitter } from 'node:events';
import { Client } from 'pg';

/** One PostgreSQL listener per API process, not one database connection per browser. */
export class SupportEventHub {
  private readonly emitter = new EventEmitter();
  private client?: Client;
  private connecting = false;
  private users = 0;
  private stopping = false;
  private retry?: NodeJS.Timeout;

  constructor(private readonly connectionString = process.env.SUPPORT_LISTEN_DATABASE_URL || process.env.DATABASE_URL) { this.emitter.setMaxListeners(0); }

  subscribe(companyId: string, callback: () => void): () => void {
    this.users++;
    this.emitter.on(companyId, callback);
    void this.connect();
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      this.emitter.removeListener(companyId, callback);
      if (--this.users === 0) {
        if (this.retry) clearTimeout(this.retry);
        this.retry = undefined;
        const client = this.client; this.client = undefined;
        void client?.end().catch(() => undefined);
      }
    };
  }

  private async connect(): Promise<void> {
    if (this.stopping || this.connecting || this.client || !this.users || !this.connectionString) return;
    this.connecting = true;
    const client = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 5000, keepAlive: true });
    this.client = client;
    const disconnected = () => {
      if (this.client !== client) return;
      this.client = undefined;
      void client.end().catch(() => undefined);
      if (this.users && !this.stopping) {
        this.retry = setTimeout(() => { this.retry = undefined; void this.connect(); }, 5000);
        this.retry.unref();
      }
    };
    client.on('error', disconnected);
    client.on('end', disconnected);
    client.on('notification', event => {
      if (event.channel === 'support_live_events' && event.payload) this.emitter.emit(event.payload);
    });
    try {
      await client.connect();
      await client.query('LISTEN support_live_events');
    } catch { disconnected(); }
    finally {
      this.connecting = false;
      // A new subscriber can arrive while the previous connection is closing.
      if (this.users && !this.client && !this.stopping && !this.retry) {
        this.retry = setTimeout(() => { this.retry = undefined; void this.connect(); }, 5000);
        this.retry.unref();
      }
    }
  }

  async close(): Promise<void> {
    this.stopping = true;
    if (this.retry) clearTimeout(this.retry);
    const client = this.client; this.client = undefined;
    this.emitter.removeAllListeners();
    await client?.end().catch(() => undefined);
  }
}

export const supportEventHub = new SupportEventHub();
