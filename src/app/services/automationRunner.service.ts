import { AutomationFlowService } from './automationFlow.service';
import { AutomationProvider } from './automationProvider.service';
import { action, decrypt, encrypt, fail, resolveParameters, shopifyContact, validateParameters } from '../utils/automationFlow';

export class AutomationRunner {
  constructor(readonly flows = new AutomationFlowService(), private readonly provider: Pick<AutomationProvider, 'execute'> = new AutomationProvider(flows)) {}
  async processNext() {
    const database = this.flows.database;
    const run = await database.transaction(async tx => {
      const row = await tx('automation_runs').where({ status: 'queued' }).orderBy('created_at').orderBy('id').forUpdate().skipLocked().first();
      if (!row) return null;
      const [claimed] = await tx('automation_runs').where({ id: row.id }).update({ status: 'running', started_at: tx.fn.now(), updated_at: tx.fn.now() }).returning('*');
      return claimed;
    });
    if (!run) return false;
    const results: any[] = [];
    let writing = false;
    const persist = (values: Record<string, any> = {}) => database('automation_runs').where({ id: run.id }).update({ results_ciphertext: encrypt(results, `run:${run.id}`), updated_at: database.fn.now(), ...values });
    try {
      const flow = await database('automation_flows').where({ id: run.flow_id }).first();
      if (!flow || flow.deleted_at || (run.kind === 'automatic' && flow.status !== 'active')) {
        await persist({ status: 'cancelled', finished_at: database.fn.now() }); return true;
      }
      const scope = { userId: flow.user_id, companyId: flow.company_id }; await this.flows.actor(scope);
      const event = await database('automation_events').where({ id: run.event_id, flow_id: flow.id }).where('expires_at', '>', new Date()).first();
      if (!event) fail(404, 'Run trigger event is unavailable');
      const payload = decrypt(event.payload_ciphertext, `event:${event.id}`);
      const context: Record<string, any> = { trigger: payload, steps: {}, ...(event.app_key === 'shopify' ? { contact: shopifyContact(payload) } : {}) };
      for (const step of run.definition.slice(1)) {
        await this.flows.actor(scope);
        if (!await database('automation_events').where({ id: event.id }).where('expires_at', '>', new Date()).first('id')) fail(409, 'The trigger event expired or was erased');
        const current = await database('automation_flows').where({ id: flow.id }).first('deleted_at', 'status');
        if (!current || current.deleted_at || (run.kind === 'automatic' && current.status !== 'active')) { await persist({ status: 'cancelled', finished_at: database.fn.now() }); return true; }
        const definition = action(step.appKey, step.key);
        const parameters = validateParameters(definition, resolveParameters(step.parameters, context));
        await this.flows.connectionFor(scope, step.appKey, step.connectionId);
        const result: any = { step_id: step._id, appKey: step.appKey, key: step.key, status: 'running', started_at: new Date().toISOString() };
        results.push(result); await persist();
        // Persist intent before calling a provider. An interrupted write is never replayed automatically.
        writing = definition.write;
        const output = await this.provider.execute(scope, step, parameters, run.id);
        if (output === undefined || Buffer.byteLength(JSON.stringify(output)) > 256 * 1024) fail(413, 'Action output exceeds 256 KB');
        result.status = 'succeeded'; result.output = output; result.finished_at = new Date().toISOString();
        context.steps[step._id] = output; await persist(); writing = false;
      }
      await persist({ status: 'succeeded', finished_at: database.fn.now() });
    } catch (error: any) {
      const status = writing ? 'requires_review' : 'failed';
      // Only application errors have safe messages. Database/provider internals are not exposed.
      const message = error?.isOperational === true ? String(error.message).slice(0, 500) : 'Flow execution failed; check the integration configuration';
      const last = results[results.length - 1];
      if (last?.status === 'running') { last.status = status; last.error = message; last.finished_at = new Date().toISOString(); }
      await persist({ status, error: message, finished_at: database.fn.now() });
    }
    return true;
  }
  async recoverStale() {
    // More than the maximum 19 bounded provider calls; a crashed write may already have committed remotely.
    await this.flows.database('automation_runs').where({ status: 'running' }).where('updated_at', '<', new Date(Date.now() - 15 * 60 * 1000))
      .update({ status: 'requires_review', error: 'Worker interrupted; inspect provider results before starting another run', finished_at: this.flows.database.fn.now(), updated_at: this.flows.database.fn.now() });
    const expired = await this.flows.database('automation_events').where('expires_at', '<=', new Date()).select('id').limit(100);
    if (expired.length) await this.flows.database('automation_events').whereIn('id', expired.map(row => row.id)).delete();
  }
}

class AutomationScheduler {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopping = false;
  private warned = false;
  private runner = new AutomationRunner();
  start() {
    if (this.timer) return; this.stopping = false;
    const tick = () => { if (!this.running && !this.stopping) this.running = this.tick().finally(() => { this.running = undefined; }); };
    this.timer = setInterval(tick, 2000); this.timer.unref(); tick();
  }
  private async tick() {
    try {
      if (!await this.runner.flows.database.schema.hasTable('automation_runs')) {
        if (!this.warned) console.warn('[Automation] Apply migration 20261022000002 before enabling flow execution');
        this.warned = true; return;
      }
      this.warned = false; await this.runner.recoverStale();
      // Separate worker replicas claim rows with SKIP LOCKED; no Redis job can be lost after an acknowledgement.
      for (let i = 0; i < 10 && !this.stopping; i++) if (!await this.runner.processNext()) break;
    } catch { console.error('[Automation] Check database/schema availability; external writes will not be retried automatically'); }
  }
  async stop() { this.stopping = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.running; }
}
export default new AutomationScheduler();
