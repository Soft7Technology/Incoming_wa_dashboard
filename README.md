# Console API - Meta WhatsApp Business Services

A scalable microservice for managing WhatsApp Business API integrations, providing comprehensive APIs for company onboarding, message management, template management, webhook handling, and credit management.

## Features

### Meta Services
- **WhatsApp Business API Integration**
- **Ads Management**
- **Bulk Campaign Management**

### Core Functionality
1. **Company Onboarding** - Multi-tenant company management with API key generation
2. **WABA Management** - Manage WhatsApp Business Accounts and phone numbers
3. **Template Management** - Sync, create, and manage message templates
4. **Messaging APIs** - Send messages, track delivery status, mark as read
5. **Message Tracking** - Track sent, delivered, read, and failed statuses
6. **Webhook Management** - Dynamic webhook endpoints with retry logic
7. **Credit Management** - Company-wise credit system for message billing

## Tech Stack

- **Runtime**: Node.js with TypeScript
- **Framework**: Express.js
- **Database**: PostgreSQL with Knex.js migrations
- **API Integration**: Meta Graph API
- **Cache**: Redis (optional, for scaling)

## Project Structure

```
console-api-new/
├── library/surefy/src/         # Shared library (reusable across microservices)
│   ├── config/                 # Database and app configuration
│   ├── database/               # Database connection
│   ├── exceptions/             # Custom error classes
│   ├── middleware/             # Auth, error handling middleware
│   ├── models/                 # Base model class
│   ├── routes/                 # Health check routes
│   ├── utils/                  # Response helpers, HTTP codes
│   └── server.ts               # Base server setup
├── src/
│   ├── app/
│   │   ├── http/controllers/   # API controllers
│   │   ├── services/           # Business logic layer
│   │   ├── models/             # Database models
│   │   ├── repository/         # Data access layer
│   │   └── interfaces/         # TypeScript interfaces
│   ├── database/migrations/    # Database migrations
│   ├── routes/                 # API routes
│   └── server.ts               # Main server entry
├── package.json
├── tsconfig.json
└── .env.example
```

## Installation

### 1. Install Dependencies

```bash
npm install
```

### 2. Environment Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Update the following variables:

```env
# Server
NODE_ENV=development
PORT=3001

# Database
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=your_password
DB_NAME=console_api_db

# Meta/Facebook
META_API_VERSION=v18.0
META_ACCESS_TOKEN=your_meta_access_token
META_BUSINESS_ID=your_business_id
META_WEBHOOK_VERIFY_TOKEN=your_webhook_verify_token
```

### 3. Database Setup

```bash
# Create database
createdb console_api_db

# Run migrations
npm run migrate:latest

# Rollback (if needed)
npm run migrate:rollback
```

### 4. Start Development Server

```bash
npm run dev
```

## API Documentation

### Base URL
```
http://localhost:3001/v1
```

### Authentication

**Two-Key Authentication System** for enhanced security:

All endpoints (except company onboarding and Meta webhook) require two headers:
```
x-api-key: sk_your_company_api_key
x-company-key: your_secure_company_key
```

**Why two keys?**
- `x-api-key`: Identifies your company (public identifier)
- `x-company-key`: Secure, non-reversible validation key (never stored in DB)

The company key is generated using HMAC SHA256 and cannot be reverse-engineered to reveal your company ID. This dual-key approach provides superior security compared to exposing company IDs directly.

📖 **See [AUTHENTICATION.md](AUTHENTICATION.md) for complete authentication guide with code examples.**

### API Endpoints

#### 1. Company Management

**Onboard New Company**
```http
POST /v1/companies
Content-Type: application/json

{
  "name": "Company Name",
  "email": "contact@company.com",
  "phone": "+1234567890",
  "business_id": "meta_business_id",
  "webhook_url": "https://company.com/webhook",
  "initial_credit": 100.00
}

Response:
{
  "success": true,
  "data": {
    "id": "company-uuid",
    "api_key": "sk_a1b2c3d4...",
    "company_key": "7a8b9c0d1e2f...",  // ⚠️ Save this! Won't be shown again
    "webhook_verify_token": "random_token",
    ...
  }
}
```

⚠️ **IMPORTANT:** Save both `api_key` and `company_key` from the response - they won't be shown again!

**Get Company Details**
```http
GET /v1/companies/:id
x-api-key: sk_a1b2c3d4...
x-company-key: 7a8b9c0d1e2f...
```

**Update Company**
```http
PUT /v1/companies/:id
x-api-key: sk_a1b2c3d4...
x-company-key: 7a8b9c0d1e2f...

{
  "name": "Updated Company Name",
  "webhook_url": "https://company.com/new-webhook"
}
```

#### 2. WABA & Phone Number Management

**Create WABA Account**
```http
POST /v1/waba
x-api-key: sk_a1b2c3d4...
x-company-key: 7a8b9c0d1e2f...

{
  "waba_id": "meta_waba_id",
  "name": "Primary WABA",
  "currency": "USD",
  "timezone": "America/New_York"
}
```

**Add Phone Number**
```http
POST /v1/waba/:wabaId/phone-numbers
x-api-key: sk_a1b2c3d4...
x-company-key: 7a8b9c0d1e2f...

{
  "phone_number_id": "meta_phone_number_id",
  "display_phone_number": "+1234567890"
}
```

**Sync Phone Numbers from Meta**
```http
POST /v1/waba/:wabaId/sync-phone-numbers
x-api-key: sk_a1b2c3d4...
x-company-key: 7a8b9c0d1e2f...
```

**Get Phone Numbers**
```http
GET /v1/waba/phone-numbers
x-api-key: sk_a1b2c3d4...
x-company-key: 7a8b9c0d1e2f...
```

#### 3. Template Management

**Sync Templates from Meta**
```http
POST /v1/templates/sync
x-api-key: sk_a1b2c3d4...
x-company-key: 7a8b9c0d1e2f...

{
  "waba_id": "waba_uuid"
}
```

**Create New Template**
```http
POST /v1/templates
x-api-key: sk_a1b2c3d4...
x-company-key: 7a8b9c0d1e2f...

{
  "waba_id": "waba_uuid",
  "name": "welcome_message",
  "language": "en_US",
  "category": "UTILITY",
  "components": [
    {
      "type": "BODY",
      "text": "Welcome {{1}}! Your code is {{2}}."
    }
  ]
}
```

**Get All Templates**
```http
GET /v1/templates?status=APPROVED&category=UTILITY
x-api-key: sk_a1b2c3d4...
x-company-key: 7a8b9c0d1e2f...
```

#### 4. Messaging APIs

**Send Message**
```http
POST /v1/messages/send
x-api-key: sk_a1b2c3d4...
x-company-key: 7a8b9c0d1e2f...

# Text Message
{
  "phone_number_id": "phone_uuid",
  "to": "+1234567890",
  "type": "text",
  "text": {
    "body": "Hello! This is a test message."
  }
}

# Template Message
{
  "phone_number_id": "phone_uuid",
  "to": "+1234567890",
  "type": "template",
  "template": {
    "name": "welcome_message",
    "language": "en_US",
    "components": [
      {
        "type": "body",
        "parameters": [
          { "type": "text", "text": "John" },
          { "type": "text", "text": "123456" }
        ]
      }
    ]
  }
}

# Image Message
{
  "phone_number_id": "phone_uuid",
  "to": "+1234567890",
  "type": "image",
  "image": {
    "link": "https://example.com/image.jpg",
    "caption": "Check this out!"
  }
}
```

**Mark Message as Read**
```http
POST /v1/messages/mark-read
x-api-key: sk_a1b2c3d4...
x-company-key: 7a8b9c0d1e2f...

{
  "phone_number_id": "phone_uuid",
  "message_id": "wamid.xxx"
}
```

**Get Messages**
```http
GET /v1/messages?status=delivered&direction=outbound&from_date=2025-01-01&to_date=2025-12-31
x-api-key: sk_a1b2c3d4...
x-company-key: 7a8b9c0d1e2f...
```

**Get Message Statistics**
```http
GET /v1/messages/stats?from_date=2025-01-01&to_date=2025-12-31
x-api-key: sk_a1b2c3d4...
x-company-key: 7a8b9c0d1e2f...
```

#### 5. Webhook Management

**Create Webhook**
```http
POST /v1/webhooks
x-api-key: sk_a1b2c3d4...
x-company-key: 7a8b9c0d1e2f...

{
  "url": "https://company.com/webhook",
  "secret": "webhook_secret_key",
  "events": ["message.sent", "message.delivered", "message.read", "message.failed", "message.received"],
  "max_retries": 3,
  "timeout_ms": 10000,
  "headers": {
    "Authorization": "Bearer token"
  }
}
```

**Get Webhooks**
```http
GET /v1/webhooks
x-api-key: sk_a1b2c3d4...
x-company-key: 7a8b9c0d1e2f...
```

**Get Webhook Logs**
```http
GET /v1/webhooks/:id/logs?limit=100
x-api-key: sk_a1b2c3d4...
x-company-key: 7a8b9c0d1e2f...
```

**Retry Failed Webhook**
```http
POST /v1/webhooks/logs/:logId/retry
x-api-key: sk_a1b2c3d4...
x-company-key: 7a8b9c0d1e2f...
```

#### 6. Credit Management

**Get Credit Balance**
```http
GET /v1/credits/balance
x-api-key: sk_a1b2c3d4...
x-company-key: 7a8b9c0d1e2f...
```

**Add Credits**
```http
POST /v1/credits/add
x-api-key: sk_a1b2c3d4...
x-company-key: 7a8b9c0d1e2f...

{
  "amount": 100.00,
  "description": "Top-up",
  "created_by": "admin@company.com"
}
```

**Get Transaction History**
```http
GET /v1/credits/transactions?limit=100
x-api-key: sk_a1b2c3d4...
x-company-key: 7a8b9c0d1e2f...
```

**Refund Credits**
```http
POST /v1/credits/refund/:transactionId
x-api-key: sk_a1b2c3d4...
x-company-key: 7a8b9c0d1e2f...

{
  "reason": "Refund for failed message"
}
```

## Webhook Events

Your webhook endpoint will receive the following events:

### Event Types
- `message.sent` - Message successfully sent to Meta
- `message.delivered` - Message delivered to recipient
- `message.read` - Message read by recipient
- `message.failed` - Message delivery failed
- `message.received` - Incoming message received

### Webhook Payload Format
```json
{
  "event": "message.delivered",
  "data": {
    "message_id": "uuid",
    "wamid": "wamid.xxx",
    "to": "+1234567890",
    "status": "delivered",
    "timestamp": "2025-12-12T10:30:00.000Z"
  },
  "timestamp": "2025-12-12T10:30:00.000Z",
  "webhook_id": "webhook_uuid"
}
```

### Webhook Security
Verify webhook signatures using HMAC SHA256:
```javascript
const crypto = require('crypto');

function verifyWebhook(payload, signature, secret) {
  const hash = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');

  return hash === signature;
}

// Check signature from header
const signature = req.headers['x-webhook-signature'];
const isValid = verifyWebhook(req.body, signature, webhookSecret);
```

## Database Schema

### Key Tables
- `companies` - Company/tenant management
- `waba_accounts` - WhatsApp Business Accounts
- `phone_numbers` - Phone numbers associated with WABAs
- `templates` - Message templates
- `messages` - All incoming/outgoing messages
- `webhooks` - Webhook configurations
- `webhook_logs` - Webhook delivery logs
- `credit_transactions` - Credit management
- `campaigns` - Bulk campaign management
- `api_keys` - API key management

## Scaling Considerations

### High-Volume Message Processing
- Use Redis for message queuing
- Implement rate limiting per Meta's requirements
- Batch message sending for campaigns
- Horizontal scaling with load balancers

### Webhook Delivery
- Async processing with job queues (Bull, BullMQ)
- Exponential backoff for retries
- Dead letter queue for failed deliveries
- Separate worker processes for webhook delivery

### Database Optimization
- Indexed fields for quick lookups
- Partitioning for messages table
- Read replicas for analytics
- Connection pooling

## Scripts

```bash
# Development
npm run dev              # Start dev server with hot reload

# Production
npm run build            # Compile TypeScript
npm start                # Start production server

# Database
npm run migrate:latest   # Run all migrations
npm run migrate:rollback # Rollback last migration
npm run migrate:make     # Create new migration

# Code Quality
npm run format           # Format code with Prettier
```

## Error Handling

All API errors follow this format:
```json
{
  "success": false,
  "message": "Error message",
  "error": {
    "details": "Additional error details"
  },
  "meta": {
    "timestamp": "2025-12-12T10:30:00.000Z"
  }
}
```

### HTTP Status Codes
- `200` - Success
- `201` - Created
- `400` - Bad Request
- `401` - Unauthorized
- `404` - Not Found
- `429` - Too Many Requests
- `500` - Internal Server Error

## Support

For issues or questions, please contact the development team or create an issue in the project repository.

## License

ISC
