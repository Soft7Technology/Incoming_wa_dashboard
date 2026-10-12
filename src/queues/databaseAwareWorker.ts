import { Worker, Processor, WorkerOptions } from 'bullmq';
import db from '@surefy/database';
import { getDatabaseFailure, reportBackgroundError } from '@surefy/utils/databaseErrors';
import { BackgroundDatabaseGate, backgroundSchemas, checkDatabaseSchema, SchemaRequirements } from '../app/utils/backgroundDatabase';

export function createDatabaseAwareWorker<Data>(name: string, processor: Processor<Data>, options: WorkerOptions,
  requirements: SchemaRequirements = backgroundSchemas[name]): Worker<Data> {
  if (!requirements) throw new Error(`Database requirements missing for worker ${name}`);
  const worker = new Worker<Data>(name, processor, { ...options, autorun: false });
  const gate = new BackgroundDatabaseGate(`Worker ${name}`);
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let checking = false;

  // BullMQ's resume() calls run() without awaiting it. Handle that promise too.
  const run = worker.run.bind(worker);
  worker.run = async () => {
    try { await run(); }
    catch (error) { if (!stopped) gate.fail(error); }
  };

  async function inspect(): Promise<void> {
    if (stopped || checking) return;
    checking = true;
    try {
      const ready = await gate.check(() => checkDatabaseSchema(db, requirements));
      if (stopped) return;
      if (!ready) await worker.pause(true);
      else if (!worker.isRunning()) {
        if (worker.isPaused()) worker.resume();
        else void worker.run();
      }
    } catch (error) { gate.fail(error); }
    finally {
      checking = false;
      if (!stopped) {
        timer = setTimeout(() => { void inspect(); }, 30000);
        timer.unref();
      }
    }
  }

  worker.on('failed', (_job, error) => {
    if (stopped || !getDatabaseFailure(error)) return;
    gate.fail(error);
    void worker.pause(true).catch(failure => reportBackgroundError(`Worker ${name}`, failure));
  });
  worker.on('closing', () => { stopped = true; if (timer) clearTimeout(timer); });
  void Promise.resolve().then(inspect);
  return worker;
}
