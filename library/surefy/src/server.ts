import express, { Application, Router } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import hpp from 'hpp';
import swaggerUi from 'swagger-ui-express';
import * as path from 'path';
import * as fs from 'fs';
import { errorHandler } from './middleware/errorHandler';
import HealthRoute from './routes/health.route';
import { UPLOADS_DIR } from './middleware/upload.middleware';

interface RouteConfig {
  basePath: string;
  route: Router;
}

const createBaseApp = (routes: RouteConfig[] = [], lifecycle: {
  onListening?: () => void;
  onShutdown?: () => void;
} = {}): Application => {
  const app: Application = express();
  const PORT = process.env.PORT || 5000;

  // Middleware
  app.use(helmet({
    contentSecurityPolicy: false, // Allow Swagger UI to load
  }));
  
  app.use(cors());
  // Contact filters accept multiple country codes in repeated query parameters.
  app.use(hpp({ whitelist: ['country_code'] }));
  app.use(compression());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(morgan('dev'));
  // app.use(express.json());

  // Serve uploaded files
  app.use('/uploads', express.static(UPLOADS_DIR));


  // Swagger Documentation
  try {
    const swaggerPath = path.join(__dirname, '../../../swagger.json');
    if (fs.existsSync(swaggerPath)) {
      const swaggerDocument = JSON.parse(fs.readFileSync(swaggerPath, 'utf8'));
      app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument, {
        customCss: '.swagger-ui .topbar { display: none }',
        customSiteTitle: 'Console API Documentation',
      }));
      console.log('📚 Swagger UI available at /api-docs');
    }
  } catch (error) {
    console.warn('⚠️  Swagger documentation not available');
  }

  // Health check route
  app.use('/health', HealthRoute);

  // Register custom routes
  routes.forEach(({ basePath, route }) => {
    app.use(basePath, route);
  });

  // 404 handler - must be after all routes
  app.use((req, res) => {
    res.status(404).json({
      success: false,
      error: {
        message: 'Route not found',
        path: req.path,
        method: req.method,
        code: 404,
      },
    });
  });

  // Error handler (must be last)
  app.use(errorHandler);

  // Start server only if not in worker mode
  if (process.env.WORKER_MODE !== 'true') {
    const server = app.listen(PORT, () => {
      lifecycle.onListening?.();
      console.log(`🚀 Server is running on port ${PORT}`);
      console.log(`📦 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`🔗 Health check: http://localhost:${PORT}/health`);
      console.log(`📚 API Documentation: http://localhost:${PORT}/api-docs`);
    });
    server.on('error', (error: NodeJS.ErrnoException) => {
      console.error(error.code === 'EADDRINUSE'
        ? `Port ${PORT} is already in use. Stop the existing API instance before starting another.`
        : `Server startup failed: ${error.message}`);
      lifecycle.onShutdown?.();
      process.exit(1);
    });

    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      lifecycle.onShutdown?.();
      server.close(() => process.exit(0));
      server.closeIdleConnections();
      setTimeout(() => process.exit(0), 5000).unref();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    process.once('SIGUSR2', shutdown);
  }

  return app;
};

export default createBaseApp;
