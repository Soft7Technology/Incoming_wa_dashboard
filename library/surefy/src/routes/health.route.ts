import { Router, Request, Response } from 'express';
import db from '../database';
import { reportBackgroundError } from '../utils/databaseErrors';

const HealthRoute = Router();
let pending: Promise<boolean> | undefined;
let healthyUntil = 0;

HealthRoute.get('/', async (req: Request, res: Response) => {
  try {
    if (Date.now() >= healthyUntil) {
      // Share one database probe across concurrent requests instead of filling the pool.
      if (!pending) pending = Promise.resolve(db.raw('SELECT 1')).then(() => {
        healthyUntil = Date.now() + 2000; return true;
      }, error => { reportBackgroundError('Health database', error); return false; })
        .finally(() => { pending = undefined; });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let ready: boolean;
      try { ready = await Promise.race([pending, new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), 1500);
      })]); } finally { if (timer) clearTimeout(timer); }
      if (!ready) throw new Error('Database is unavailable');
    }
    res.json({
      success: true,
      message: 'Service is healthy',
      data: {
        status: 'UP',
        timestamp: new Date().toISOString(),
        database: 'Connected',
      },
    });
  } catch (error: any) {

    res.status(503).json({
      success: false,
      message: 'Service is unhealthy',
      data: {
        status: 'DOWN',
        timestamp: new Date().toISOString(),
        database: 'Disconnected',
      },
    });
  }
});
export default HealthRoute;
