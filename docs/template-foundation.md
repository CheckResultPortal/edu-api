# Template foundation

## Scope and ownership

This template supplies only reusable technical capabilities: configuration, JSON:API-shaped HTTP responses, structured logging, operational health checks, PostgreSQL/Prisma, Redis, and BullMQ. It owns no business tables, customer data, domain state, or business invariants.

## Standards and compliance boundary

- NestJS runs on the Fastify adapter. HTTP APIs are versioned below `/v1`.
- Operational responses use a JSON:API-shaped `data`/`errors` envelope with a correlation ID. It is not a claim that every future product endpoint is fully JSON:API compliant; product teams must either implement that standard deliberately or document another approved contract.
- `GET /v1/openapi.json` exposes the generated OpenAPI contract.
- `GET /v1/health/live` verifies process liveness without dependencies.
- `GET /v1/health/ready` concurrently runs PostgreSQL `SELECT 1` and Redis `PING`. Dependency failure returns the safe `DEPENDENCY_UNAVAILABLE` error without connection details.
- Prisma is the PostgreSQL adapter. Redis is lazily connected with offline queues disabled. BullMQ is the queue abstraction.

Readiness is O(1) time and O(1) memory: it performs two constant-size checks in parallel, creates no data, and does not scan application records. The health module reuses one client set and shuts down Redis before PostgreSQL.

## Adding a product module

Before adding a feature, record its owner, invariants, authorisation and tenant boundaries, data classification, failure/retry behaviour, audit needs, and acceptance tests. Put domain logic in its own library; keep Nest controllers as transport adapters and keep migrations/constraints with the owning module.

For writes that must be correct under retries or concurrency, use database constraints and short atomic transactions. Do not rely on in-process locks, Redis, or queue delivery for correctness.

## Verification

Run `pnpm exec nx sync:check`, `pnpm lint`, `pnpm test`, `pnpm build`, and `pnpm format:check`. With Compose PostgreSQL and Redis running, also run `pnpm exec nx e2e public-api-e2e` and `pnpm exec nx e2e admin-api-e2e`.
