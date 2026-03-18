import { Router, Request, Response } from 'express';
import db from '../database';

const HealthRoute = Router();

HealthRoute.get('/', async (req: Request, res: Response) => {
  try {
    await db.raw('SELECT 1');
    res.json({
      success: true,
      message: 'Service is healthy',
      data: {
        status: 'UP',
        timestamp: new Date().toISOString(),
        database: 'Connected',
      },
    });
  } catch (error) {
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
