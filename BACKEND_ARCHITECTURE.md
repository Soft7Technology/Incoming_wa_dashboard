# Backend Architecture & Code Explanation

This document provides a detailed overview of the backend codebase structure, request lifecycle, and core modules for the Meta WhatsApp Business API Dashboard (`Incoming_wa_dashboard`).

## 1. Tech Stack Overview

- **Runtime & Language:** Node.js with TypeScript.
- **Framework:** Express.js for routing and HTTP server management.
- **Database:** PostgreSQL for relational data storage.
- **Query Builder:** Knex.js for database queries and migration management.
- **Background Jobs:** BullMQ with Redis for asynchronous task processing (e.g., campaigns, retries, imports).

---

## 2. Core Directory Structure (`src/`)

The application follows a layered architectural pattern (Controller-Service-Model) which ensures separation of concerns.

```text
src/
├── app/
│   ├── http/controllers/  # (1) Request validation and HTTP response mapping
│   ├── services/          # (2) Core business logic
│   ├── models/            # (3) Database interactions (Knex queries)
│   ├── middleware/        # (4) Express middlewares (Auth, Error handling)
│   ├── utils/             # Helper functions (Crypto, File parsers)
│   └── interfaces/        # TypeScript types and interfaces
├── database/
│   └── migrations/        # Knex database schema migrations
├── queues/                # BullMQ Queue definitions
│   └── processors/        # BullMQ Worker logic for processing jobs
├── routes/                # Express router configurations
├── workers/               # Entry points for standalone worker processes
└── server.ts              # Main entry point for the HTTP API Server
```

---

## 3. The Request Lifecycle (How a request flows)

Whenever a request hits the API (e.g., `/v1/campaigns/send`), it goes through the following sequence:

1. **Route (`src/routes/`):** Matches the HTTP method and path. Attaches middleware.
2. **Middleware (`src/app/middleware/`):** Checks for authentication (`x-api-key` & `x-company-key`), logs the request, and catches early errors.
3. **Controller (`src/app/http/controllers/`):** 
   - Extracts data from `req.body` or `req.params`.
   - Performs basic validation.
   - Calls the appropriate Service method.
   - Formats the success/error response back to the client.
4. **Service (`src/app/services/`):**
   - Contains the heavy business logic (e.g., formatting messages, interacting with Meta Graph API).
   - Calls Models to read/write from the database.
5. **Model (`src/app/models/`):**
   - Executes raw Knex queries or Objection.js-like query building to fetch or mutate data in PostgreSQL.

---

## 4. Key Modules Explained

### A. Meta / WhatsApp Integration (`waba`, `meta`, `messages`)
- Responsible for onboarding WhatsApp Business Accounts (WABA) and syncing phone numbers.
- **Message Sending:** Handled by `message.service.ts` which communicates directly with Meta Graph API.
- **Webhooks:** Listens to Meta webhook events (sent, delivered, read, failed) and logs them into the database to track message statuses.

### B. Campaign Management (`campaigns`)
- Used for bulk messaging (Broadcasting).
- **Auto-Queueing:** When a campaign is started, it is pushed to a background queue (`campaignExecution.queue.ts`).
- **Processing:** `campaignExecution.processor.ts` reads the job, batches contacts, and sends messages asynchronously without blocking the main HTTP server.
- **Retry Mechanism:** Failed campaign messages can be retried using `campaignRetry.queue.ts`.

### C. Background Jobs & Workers (`queues/` & `workers/`)
To keep the API fast, heavy tasks are offloaded to BullMQ (Redis):
- `contactImport.processor.ts`: Processes heavy CSV/Excel imports for contacts.
- `bulkMessageSend.processor.ts`: Handles the actual dispatch of messages to Meta.
- `workers/index.ts`: The entry file that starts all processors. Usually run as a separate process in production.

### D. AI Assistant (`aiAssistant`)
- Manages AI bots connected to WhatsApp.
- **Controllers & Services:** Setup prompts, select AI models (Gemini/OpenAI), and define the bot's behavior.
- *(Note: The Knowledge Base document upload feature has been recently removed/hidden to simplify the logic.)*

### E. Authentication & Companies (`auth`, `company`)
- Multi-tenant architecture. Every request requires `x-api-key` and `x-company-key`.
- `auth.controller.ts` issues JWT tokens for dashboard login.

---

## 5. Database Philosophy

- **Migrations:** All schema changes are tracked in `src/database/migrations/`. Never edit the DB manually; always write a migration file.
- **BaseModel:** Many models extend a `BaseModel` class that provides generic CRUD operations (`findById`, `create`, `update`, `delete`).

## 6. Starting the App

- **Main API Server:** `npm run dev` (Runs `src/server.ts`)
- **Background Workers:** The queues require a Redis instance to be running locally or remotely. Workers process jobs concurrently.
