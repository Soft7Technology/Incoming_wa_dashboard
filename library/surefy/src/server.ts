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
import { CustomError } from './exceptions/CustomError';
import HealthRoute from './routes/health.route';
import { UPLOADS_DIR } from './middleware/upload.middleware';
import { protectAsyncRoutes } from './utils/asyncRouter';
import { requestCapacity } from './middleware/requestCapacity';

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
  app.use(requestCapacity());

  // Middleware
  app.use(helmet({
    contentSecurityPolicy: false, // Allow Swagger UI to load
  }));
  
  app.use(cors<express.Request>((req, done) => {
    // Google OAuth sets a browser-binding cookie on the API origin. Only the
    // configured dashboard origin may use credentialed cross-origin requests.
    if (req.url.startsWith('/v1/admin/google-sheets') || req.url.startsWith('/v1/integrations/google/') ||
        req.url.startsWith('/v1/admin/google-people') || req.url.startsWith('/v1/integrations/google-people/') ||
        req.url.startsWith('/v1/admin/shopify') || req.url.startsWith('/v1/integrations/shopify/')) {
      let origin: string | false = false;
      try {
        const shopifyRequest = req.url.startsWith('/v1/admin/shopify') || req.url.startsWith('/v1/integrations/shopify/');
        const peopleRequest = req.url.startsWith('/v1/admin/google-people') || req.url.startsWith('/v1/integrations/google-people/');
        const configured = new URL((shopifyRequest ? process.env.SHOPIFY_FRONTEND_URL :
          peopleRequest ? process.env.GOOGLE_PEOPLE_FRONTEND_URL || process.env.GOOGLE_FRONTEND_URL : process.env.GOOGLE_FRONTEND_URL) || '');
        if (!configured.username && !configured.password && (configured.protocol === 'https:' ||
            (configured.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(configured.hostname)))) origin = configured.origin;
      } catch { /* Same-origin and server-to-server usage need no CORS header. */ }
      return done(null, { origin, credentials: true });
    }
    done(null, { origin: '*' });
  }));
  // Contact filters accept multiple country codes in repeated query parameters.
  app.use(hpp({ whitelist: ['country_code'] }));
  app.use(compression());
  app.use(express.json({ limit: '10mb', verify: (req, _res, buffer) => {
    // Signature validation must use the exact bytes received, before JSON parsing.
    if (['/v1/facebook/webhook', '/v1/facebook/instagram/webhook', '/v1/webhooks/meta'].includes(req.url?.split('?')[0] || '') ||
        /^\/v1\/integrations\/shopify\/webhook(?:\/|$)/.test(req.url?.split('?')[0] || '') ||
        /^\/v1\/webhook\/flows\//.test(req.url?.split('?')[0] || '')) {
      if (req.url?.startsWith('/v1/webhook/flows/') && buffer.length > 1024 * 1024) {
        throw new CustomError('Automation webhook exceeds 1 MB', 413);
      }
      (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
    }
  } }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(morgan('dev', { skip: req => req.originalUrl.startsWith('/v1/admin/waba/onboard') || req.originalUrl.startsWith('/v1/facebook/') || req.originalUrl.startsWith('/v1/integrations/google/') || req.originalUrl.startsWith('/v1/integrations/shopify/') || req.originalUrl.startsWith('/v1/integrations/google-people/') || req.originalUrl.startsWith('/v1/admin/google-people') || req.originalUrl.startsWith('/v1/webhook/flows/') }));
  // app.use(express.json());

  // Serve uploaded files
  // Explicitly exclude dot directories such as the private media worker spool.
  app.use('/uploads', express.static(UPLOADS_DIR, { dotfiles: 'ignore' }));


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
  // Liveness must stay independent of PostgreSQL/Redis availability.
  app.get('/live', (_req, res) => res.json({ success: true }));
  app.use('/health', HealthRoute);

  // Register custom routes
  routes.forEach(({ basePath, route }) => {
    protectAsyncRoutes(route);
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
