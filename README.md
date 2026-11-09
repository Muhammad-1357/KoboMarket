# KoboMarket

KoboMarket is a multi-vendor marketplace backend with a PostgreSQL double-entry ledger and escrow workflow. The project keeps marketplace identity/catalogue data in MongoDB and financial records in PostgreSQL.

## Requirements

- Docker with the Compose plugin
- Node.js 22 or later and npm, if running scripts from the host

## Run locally with Docker Compose

1. Copy the example environment file and set a private seed password and random secrets:

   ```powershell
   Copy-Item .env.example .env
   ```

   Edit `.env` before starting. Use random values for `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, and `WEBHOOK_SECRET`; do not commit `.env`. `SEED_PASSWORD` must contain at least 12 characters.

2. Build and start the API and databases:

   ```powershell
   docker compose up --build
   ```

   The API container waits for MongoDB and PostgreSQL health checks, applies PostgreSQL migrations, and starts the development server. The first build requires network access to download npm packages and Docker images.

3. In a second terminal, seed the development data:

   ```powershell
   docker compose exec api npm run seed
   ```

   The seed script is idempotent for its sample users, products, and wallet accounts. It creates one admin, three approved vendor accounts, twenty products, and five buyers. The buyers' wallets receive 500,000 kobo each. Seed users share the `SEED_PASSWORD` configured in `.env`.

4. Open:

   - API: `http://localhost:3000/api/v1`
   - Swagger UI: `http://localhost:3000/api-docs`
   - Health endpoint: `http://localhost:3000/api/v1/health`

   Import [postman/KoboMarket.postman_collection.json](./postman/KoboMarket.postman_collection.json) into Postman for a request collection. Configure its `baseUrl`, `token`, and other variables for the account and resource IDs being used.

   Stop the stack with `Ctrl+C`. Persistent MongoDB and PostgreSQL data is stored in Docker volumes. To remove the containers while retaining that data, use `docker compose down`; volume deletion is a separate, destructive operation.

## Run scripts from the host

If running outside Docker, install dependencies and ensure MongoDB and PostgreSQL are reachable using the connection strings in `.env`:

```powershell
npm ci
npm run migrate:latest
npm run seed
npm run dev
```

Other project commands:

```powershell
npm test
npm run build
npm run audit:ledger
```

`npm run audit:ledger` requires a reachable, migrated PostgreSQL database. The audit checks balanced transactions, cached account balances against ledger entries, and the funded-versus-paid-out money invariant.

### Integration test databases

The Jest/Supertest suite uses real MongoDB and PostgreSQL instances to exercise webhook idempotency, ledger transactions, and stock/wallet concurrency. It refuses to run unless both configured database names end in `_test`.

```powershell
Copy-Item .env.test.example .env.test
npm run test:db:up
npm test
$env:DATABASE_URL = "postgresql://kobomarket:kobomarket@127.0.0.1:5433/kobomarket_test"
npm run audit:ledger
npm run test:db:down
```

The test database service uses separate ports from the development stack and does not share its database volumes. The test setup runs migrations and clears only those `_test` databases between test cases. Keep `.env.test` private and do not point test URLs at development or production databases.

## Configuration

See [.env.example](./.env.example) for the required environment variables and development defaults.

| Variable | Purpose |
|---|---|
| `MONGODB_URI` | MongoDB connection string |
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_ACCESS_SECRET` | Access-token signing key (at least 32 characters) |
| `JWT_REFRESH_SECRET` | Refresh-token signing key (at least 32 characters) |
| `WEBHOOK_SECRET` | Mock funding-webhook HMAC key (at least 16 characters) |
| `COMMISSION_BPS` | Commission in basis points; 500 means 5% |
| `ESCROW_TIMEOUT_HOURS` | Time after shipment before eligible auto-completion |
| `PAYOUT_MINIMUM_KOBO` | Minimum payout amount in integer kobo |
| `SEED_PASSWORD` | Development password shared by seeded users |

The Compose file supplies container-network database addresses for the API. Do not use the example secrets or local database credentials in a public deployment.

## Architecture

```mermaid
flowchart LR
  Client --> API[Express API]
  API --> Routes[Routes and validation]
  Routes --> Services[Business services]
  Services --> Mongo[(MongoDB)]
  Services --> PG[(PostgreSQL)]
  Services --> Outbox[PostgreSQL outbox]
  Outbox --> Worker[Outbox worker]
  Worker --> Mongo
  Worker --> Notifications[MongoDB notifications]
  Scheduler[Scheduled jobs] --> PG
  Scheduler --> Mongo
```

Routes apply authentication, RBAC, and request validation. Business operations are implemented in service modules. Mongo models own user, vendor, product, review, cart, login-attempt, and notification data. Knex provides PostgreSQL access and migrations for all financial and order data.

## Database split and money rules

MongoDB stores users, profiles, vendor stores, products, reviews, carts, login-attempt records, and notifications. It does not store wallet balances or other authoritative money state.

PostgreSQL stores user and system accounts, transactions, append-only ledger entries, orders, sub-orders, order items, payouts, disputes, settings, idempotency records, and outbox events. All financial amounts are integer kobo (`₦1 = 100 kobo`). The ledger schema rejects non-positive entry amounts, and the database prevents ledger-row updates and deletes. Every transfer posts matching debit and credit entries and updates account balance caches in one SQL transaction.

Required system accounts include `PLATFORM_ESCROW`, `PLATFORM_REVENUE`, and `PLATFORM_PAYOUT_CLEARING`. Funding and external payout boundary accounts are also represented in PostgreSQL for accounting.

PostgreSQL user account IDs and vendor IDs are MongoDB user IDs stored as external string references; PostgreSQL does not enforce foreign keys across the two database servers. Products refer to their MongoDB vendor-store document in MongoDB, while each PostgreSQL sub-order records that store owner's user ID so its proceeds are credited to the matching PostgreSQL wallet.

### PostgreSQL relationship sketch

```mermaid
erDiagram
  ACCOUNTS ||--o{ LEDGER_ENTRIES : records
  TRANSACTIONS ||--|{ LEDGER_ENTRIES : posts
  ORDERS ||--|{ SUB_ORDERS : contains
  SUB_ORDERS ||--|{ ORDER_ITEMS : contains
  SUB_ORDERS ||--o| DISPUTES : may_have
  ACCOUNTS ||--o{ PAYOUTS : funds
  TRANSACTIONS {
    uuid id PK
    string reference UK
    string type
    string status
    string idempotency_key UK
    jsonb metadata
  }
  ACCOUNTS {
    uuid id PK
    string owner_type
    string owner_id
    string currency
    bigint balance_kobo
    string status
  }
  LEDGER_ENTRIES {
    uuid id PK
    uuid transaction_id FK
    uuid account_id FK
    string direction
    bigint amount_kobo
  }
  ORDERS {
    uuid id PK
    string buyer_id
    string status
    bigint total_kobo
  }
  SUB_ORDERS {
    uuid id PK
    uuid order_id FK
    string vendor_id
    string status
    bigint total_kobo
  }
  ORDER_ITEMS {
    uuid id PK
    uuid order_id FK
    uuid sub_order_id FK
    string product_id
    int quantity
    bigint unit_price_kobo
  }
  PAYOUTS {
    uuid id PK
    uuid vendor_account_id FK
    string vendor_id
    bigint amount_kobo
    string status
  }
  DISPUTES {
    uuid id PK
    uuid sub_order_id FK
    string buyer_id
    string status
    string resolution
  }
```

MongoDB collections are `users`, `vendors`, `products`, `reviews`, `carts`, `loginattempts`, and `notifications`.

## Cross-database consistency, concurrency, and idempotency

- **Registration:** a new MongoDB user is marked `provisioning` while its PostgreSQL wallet account is created. If account creation or activation fails, the service compensates by deleting any wallet it created and then deleting the MongoDB user. Compensation failures are logged as fatal and must be reconciled.
- **Checkout and stock:** product and current stock/price data are read from MongoDB. Stock is reserved using conditional MongoDB updates; wallet funds and order/ledger records are handled in a PostgreSQL transaction with the buyer wallet locked. If the SQL operation fails after stock reservation, the service attempts to restore stock and persists failed stock restoration for the outbox worker to retry.
- **Ledger:** ledger rows are never edited or deleted. Corrections use new reverse transfers. Wallet balances are cached on PostgreSQL account rows and can be compared with ledger-derived balances by the audit script.
- **Concurrency:** PostgreSQL row locks serialize spends from the same wallet. MongoDB stock updates include a sufficient-stock condition, so only one competing checkout can reserve the last unit.
- **Idempotency:** funding, checkout, and payout operations require an `Idempotency-Key`. Requests are associated with a body hash; replaying the same request returns its existing result, while reusing the key for a different request is a conflict.
- **Notifications and stock retries:** SQL outbox events are consumed asynchronously and are retried on failure. Notification documents are created in MongoDB by this worker.

## API areas

The API is mounted at `/api/v1`. Swagger UI is available at `/api-docs`. Routes include authentication, user profiles, vendors, products and reviews, carts, wallets and funding webhooks, checkout/orders, disputes, payouts, notifications, and admin/reporting operations. The funding webhook is available at the assignment path `/api/v1/webhooks/paystack`. The earlier `/api/v1/wallet/webhooks/paystack` path remains as a backward-compatible alias.

The payment and payout integrations currently use a local mock provider; no real Paystack credentials or bank transfers are performed. The mock webhook signature is HMAC-SHA512 using `WEBHOOK_SECRET`. In the Postman collection, copy the funding `reference` into `fundingReference`, set `amountKobo`, and provide the HMAC-SHA512 signature of the exact raw webhook JSON in `webhookSignature`.

## Current limitations

- The provider is a local mock, not a live Paystack integration.
- A recorded demo video must be produced separately; this repository cannot create that recording.
- Cross-database compensation cannot be atomic. Fatal compensation errors require operational review and reconciliation.
- Run the test suite and ledger audit against configured databases before treating a deployment as verified.
