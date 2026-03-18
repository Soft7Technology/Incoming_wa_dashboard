# Deployment Guide

## Pre-Deployment Checklist

### 1. Environment Setup
- [ ] Create production database
- [ ] Set all environment variables
- [ ] Generate secure secrets
- [ ] Configure Meta webhook URL
- [ ] Setup domain and SSL certificate

### 2. Database Setup
```bash
# Create production database
createdb console_api_production

# Run migrations
NODE_ENV=production npm run migrate:latest
```

### 3. Environment Variables (Production)
```env
NODE_ENV=production
PORT=3001

# Database
DB_HOST=your-db-host.com
DB_PORT=5432
DB_USER=console_api_user
DB_PASSWORD=STRONG_PASSWORD_HERE
DB_NAME=console_api_production

# Redis (Recommended for production)
REDIS_HOST=your-redis-host.com
REDIS_PORT=6379
REDIS_PASSWORD=REDIS_PASSWORD_HERE

# Meta Configuration
META_API_VERSION=v18.0
META_ACCESS_TOKEN=YOUR_PRODUCTION_META_TOKEN
META_BUSINESS_ID=YOUR_BUSINESS_ID
META_WEBHOOK_VERIFY_TOKEN=RANDOM_SECURE_STRING_32_CHARS

# Security
JWT_SECRET=RANDOM_SECURE_STRING_64_CHARS
API_KEY_SALT=RANDOM_SECURE_STRING_32_CHARS

# Application
WEBHOOK_RETRY_ATTEMPTS=3
WEBHOOK_RETRY_DELAY=1000
MESSAGE_BATCH_SIZE=100
RATE_LIMIT_PER_MINUTE=100
LOG_LEVEL=info
```

## Deployment Options

### Option 1: Docker (Recommended)

#### Create Dockerfile
```dockerfile
FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start server
CMD ["npm", "start"]
```

#### Create docker-compose.yml
```yaml
version: '3.8'

services:
  app:
    build: .
    ports:
      - "3001:3001"
    environment:
      - NODE_ENV=production
      - DB_HOST=postgres
      - REDIS_HOST=redis
    depends_on:
      - postgres
      - redis
    restart: unless-stopped

  postgres:
    image: postgres:14-alpine
    environment:
      POSTGRES_DB: console_api_production
      POSTGRES_USER: console_api_user
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    command: redis-server --requirepass ${REDIS_PASSWORD}
    volumes:
      - redis_data:/data
    restart: unless-stopped

volumes:
  postgres_data:
  redis_data:
```

#### Deploy with Docker
```bash
# Build and start
docker-compose up -d

# Run migrations
docker-compose exec app npm run migrate:latest

# View logs
docker-compose logs -f app

# Stop
docker-compose down
```

### Option 2: PM2 (Process Manager)

```bash
# Install PM2 globally
npm install -g pm2

# Create ecosystem.config.js
cat > ecosystem.config.js << EOF
module.exports = {
  apps: [{
    name: 'console-api',
    script: './dist/src/server.js',
    instances: 'max',
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production',
      PORT: 3001
    },
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true
  }]
}
EOF

# Build
npm run build

# Start with PM2
pm2 start ecosystem.config.js

# Save PM2 config
pm2 save

# Setup PM2 startup
pm2 startup

# Monitor
pm2 monit

# View logs
pm2 logs console-api

# Restart
pm2 restart console-api

# Stop
pm2 stop console-api
```

### Option 3: Systemd Service

```bash
# Create service file
sudo nano /etc/systemd/system/console-api.service
```

```ini
[Unit]
Description=Console API Service
After=network.target postgresql.service

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/console-api-new
Environment=NODE_ENV=production
ExecStart=/usr/bin/node /path/to/console-api-new/dist/src/server.js
Restart=on-failure
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=console-api

[Install]
WantedBy=multi-user.target
```

```bash
# Reload systemd
sudo systemctl daemon-reload

# Enable service
sudo systemctl enable console-api

# Start service
sudo systemctl start console-api

# Check status
sudo systemctl status console-api

# View logs
sudo journalctl -u console-api -f
```

## Nginx Reverse Proxy

```nginx
server {
    listen 80;
    server_name api.yourdomain.com;

    # Redirect to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name api.yourdomain.com;

    # SSL Configuration
    ssl_certificate /etc/letsencrypt/live/api.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.yourdomain.com/privkey.pem;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # Rate limiting
    limit_req_zone $binary_remote_addr zone=api_limit:10m rate=100r/m;
    limit_req zone=api_limit burst=20 nodelay;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # Health check endpoint
    location /health {
        proxy_pass http://localhost:3001/health;
        access_log off;
    }
}
```

## Database Optimization

### PostgreSQL Configuration (postgresql.conf)
```ini
# Memory
shared_buffers = 256MB
effective_cache_size = 1GB
maintenance_work_mem = 64MB
work_mem = 4MB

# Connections
max_connections = 100

# Performance
random_page_cost = 1.1
effective_io_concurrency = 200

# Logging
log_min_duration_statement = 1000
log_line_prefix = '%m [%p] %u@%d '
```

### Create Database Indexes
```sql
-- Additional performance indexes
CREATE INDEX CONCURRENTLY idx_messages_company_created
  ON messages(company_id, created_at DESC);

CREATE INDEX CONCURRENTLY idx_messages_status_created
  ON messages(status, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX CONCURRENTLY idx_webhook_logs_created
  ON webhook_logs(created_at DESC);

-- Partial indexes for active records
CREATE INDEX CONCURRENTLY idx_active_companies
  ON companies(id)
  WHERE status = 'active' AND deleted_at IS NULL;
```

## Monitoring Setup

### Health Check Endpoint
```bash
# Should return 200 OK
curl https://api.yourdomain.com/health
```

### Setup Monitoring (Example with UptimeRobot)
1. Add health check: `https://api.yourdomain.com/health`
2. Check interval: 5 minutes
3. Alert via email/SMS/Slack

### Application Metrics
```bash
# Install Prometheus client (future enhancement)
npm install prom-client

# Expose metrics endpoint at /metrics
# Monitor:
# - Request rate
# - Response time
# - Error rate
# - Message send rate
# - Webhook delivery success rate
```

## Backup Strategy

### Database Backups
```bash
# Create backup script
cat > /usr/local/bin/backup-console-api.sh << 'EOF'
#!/bin/bash
BACKUP_DIR="/backups/console-api"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/console_api_$TIMESTAMP.sql.gz"

mkdir -p $BACKUP_DIR

pg_dump -h localhost -U console_api_user -d console_api_production | gzip > $BACKUP_FILE

# Keep only last 7 days
find $BACKUP_DIR -name "*.sql.gz" -mtime +7 -delete

echo "Backup completed: $BACKUP_FILE"
EOF

chmod +x /usr/local/bin/backup-console-api.sh

# Add to crontab (daily at 2 AM)
0 2 * * * /usr/local/bin/backup-console-api.sh
```

### Restore from Backup
```bash
gunzip -c backup.sql.gz | psql -h localhost -U console_api_user -d console_api_production
```

## Scaling Strategies

### Horizontal Scaling
```bash
# Run multiple instances behind load balancer
# Use PM2 cluster mode or Docker replicas

# PM2 Cluster
pm2 start ecosystem.config.js -i max

# Docker Compose Scale
docker-compose up -d --scale app=3
```

### Database Connection Pooling
```typescript
// Already configured in knex.config.ts
pool: {
  min: 2,
  max: 20,  // Adjust based on load
}
```

### Redis Caching (Future Enhancement)
```typescript
// Cache frequently accessed data
// - Company configs
// - Template data
// - Phone number mappings
```

## SSL Certificate (Let's Encrypt)

```bash
# Install Certbot
sudo apt-get install certbot python3-certbot-nginx

# Get certificate
sudo certbot --nginx -d api.yourdomain.com

# Auto-renewal (already setup by certbot)
sudo certbot renew --dry-run
```

## Security Hardening

### Firewall Rules
```bash
# Allow SSH, HTTP, HTTPS only
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

### Database Security
```bash
# Use strong passwords
# Restrict network access
# Enable SSL for database connections
# Regular security updates
```

### Application Security
- Keep dependencies updated: `npm audit`
- Use environment variables for secrets
- Enable CORS only for trusted domains
- Implement rate limiting
- Validate all user inputs
- Use prepared statements (already done via Knex)

## Rollback Plan

```bash
# Keep previous Docker image
docker tag console-api:latest console-api:backup

# If rollback needed
docker-compose down
docker tag console-api:backup console-api:latest
docker-compose up -d

# Database rollback
npm run migrate:rollback
```

## Post-Deployment Verification

```bash
# 1. Health check
curl https://api.yourdomain.com/health

# 2. Test company onboarding
curl -X POST https://api.yourdomain.com/v1/companies \
  -H "Content-Type: application/json" \
  -d '{"name":"Test","email":"test@test.com"}'

# 3. Test authentication
curl https://api.yourdomain.com/v1/companies \
  -H "x-api-key: YOUR_API_KEY" \
  -H "x-company-id: COMPANY_ID"

# 4. Check logs
pm2 logs console-api
# or
docker-compose logs -f app

# 5. Monitor for errors
tail -f /var/log/nginx/error.log
```

## Maintenance

### Regular Tasks
- [ ] Weekly: Review logs for errors
- [ ] Weekly: Check disk space
- [ ] Monthly: Review and optimize slow queries
- [ ] Monthly: Update dependencies
- [ ] Quarterly: Load testing
- [ ] Quarterly: Security audit

### Updates
```bash
# Update dependencies
npm update
npm audit fix

# Test in staging
npm run build
npm run migrate:latest

# Deploy to production
git pull
npm install
npm run build
npm run migrate:latest
pm2 restart console-api
```

## Support

- Documentation: See README.md
- Emergency: contact@surefy.com
- Slack: #console-api-support
