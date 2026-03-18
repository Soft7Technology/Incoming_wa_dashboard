/**
 * PM2 Ecosystem Configuration
 *
 * Usage:
 *   Development: pm2 start ecosystem.config.js
 *   Production:  pm2 start ecosystem.config.js --env production
 *   Monitor:     pm2 monit
 *   Logs:        pm2 logs
 *   Restart:     pm2 restart all
 *   Stop:        pm2 stop all
 */

module.exports = {
  apps: [
    {
      name: 'console-api',
      script: 'dist/src/server.js',
      instances: 2, // Use 2 instances for load balancing
      exec_mode: 'cluster',
      node_args: '-r ts-node/register/transpile-only -r tsconfig-paths/register',
      env: {
        NODE_ENV: 'development',
        PORT: 3001,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
      error_file: './logs/api-error.log',
      out_file: './logs/api-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
    },
    {
      name: 'console-worker',
      script: 'dist/src/workers/index.js',
      instances: 1, // Keep only 1 worker instance
      exec_mode: 'fork',
      node_args: '-r ts-node/register/transpile-only -r tsconfig-paths/register',
      env: {
        NODE_ENV: 'development',
        WORKER_MODE: 'true',
      },
      env_production: {
        NODE_ENV: 'production',
        WORKER_MODE: 'true',
      },
      error_file: './logs/worker-error.log',
      out_file: './logs/worker-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
    },
  ],
};
