# Check Result Portal / EduVoucher API

Backend platform for the EduVoucher voucher-selling product and its future Check Result Portal capabilities. It is an Nx monorepo built with NestJS, Fastify, PostgreSQL/Prisma, Redis, BullMQ, structured logging, health checks, and generated OpenAPI.

Phase 1 is a guest voucher-purchase platform for WAEC result-checker demand: secure inventory import, provider-verified payments, exactly-once fulfilment obligations, concurrent-safe voucher allocation, paid zero-stock backlog, automatic FIFO restock fulfilment, and independent SMS/email delivery. Result checking is a later optional add-on and must never block voucher delivery.

## Applications

| Application | Purpose                                                                                                 | Default port |
| ----------- | ------------------------------------------------------------------------------------------------------- | ------------ |
| public-api  | Guest product, order, payment, status, and public USSD entry workflows                                  | 3001         |
| admin-api   | Authenticated administration, imports, stock, communication, reconciliation, and audit workflows        | 3002         |
| worker      | Outbox, allocation, backlog, communication, stock, reconciliation, and recovery work; no HTTP endpoints | —            |

Both HTTP APIs expose health/live, health/ready, and `openapi.json` below
`/v1`. In development and staging, interactive Swagger documentation is at
`/v1/api/docs` (for example, `http://localhost:3002/v1/api/docs` for Admin
API). The interactive UI is intentionally disabled in production; the JSON
contract remains available.

## Local development

Install Node.js 22+ and pnpm 10, then run:

    pnpm install
    docker compose up -d postgres redis
    pnpm exec nx serve public-api
    pnpm exec nx serve admin-api
    pnpm exec nx serve worker

Copy each required .env.example to a local .env file before running an application. Never commit a real .env file.

## Engineering rules

The detailed product engineering pack may be supplied locally as eduvoucher-engineering-docs. It is intentionally ignored and never pushed from this repository. When present, it is mandatory reading for product work; AGENTS.md contains the binding authority order, core invariants, workflow, and definition of done.

## Quality checks

    pnpm lint
    pnpm test
    pnpm build
    pnpm format:check
