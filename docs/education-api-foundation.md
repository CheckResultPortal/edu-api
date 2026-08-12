# Education API foundation

## Scope and ownership

The foundation provides configuration, JSON:API-shaped operational responses, structured logging, operational health checks, PostgreSQL/Prisma, Redis, and BullMQ. It owns no education tables, learner data, school data, academic records, or result workflows.

## Standards and compliance boundary

- NestJS runs on Fastify. HTTP APIs are versioned under `/v1`.
- Operational responses use a JSON:API-shaped `data`/`errors` envelope and correlation ID. Feature teams must deliberately implement their selected API contract for product endpoints.
- `GET /v1/openapi.json` exposes the generated OpenAPI contract.
- `GET /v1/health/live` verifies process liveness without dependency access.
- `GET /v1/health/ready` concurrently runs PostgreSQL `SELECT 1` and Redis `PING`. A dependency failure returns `DEPENDENCY_UNAVAILABLE` without connection details.
- Prisma is the PostgreSQL adapter. Redis is lazily connected with offline queues disabled. BullMQ is the queue abstraction.

Readiness is O(1) time and O(1) memory: it performs two constant-size checks in parallel, creates no records, and does not scan application data. The health module reuses one client set and shuts down Redis before PostgreSQL.

## Adding an education feature

Before introducing a feature, define its module owner, records it owns, authorisation and tenant boundaries, privacy classification, failure/retry behavior, audit needs, and acceptance tests. For student, guardian, staff, institution, assessment, or result data, also define who may view and amend it, retention expectations, and any publication/release rules.

Keep domain logic in purpose-specific libraries. Controllers are transport adapters; migrations and database constraints belong to the module that owns the data.

Critical writes must use database constraints and short atomic transactions. Make idempotency and retry behavior explicit. Do not rely on in-process locks, Redis, or queue delivery for correctness.

## Verification

Run `pnpm exec nx sync:check`, `pnpm lint`, `pnpm test`, `pnpm build`, and `pnpm format:check`. With Compose PostgreSQL and Redis running, also run `pnpm exec nx e2e public-api-e2e` and `pnpm exec nx e2e admin-api-e2e`.
