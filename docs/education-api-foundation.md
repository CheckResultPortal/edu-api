# EduVoucher API foundation

## Scope

The shared foundation provides configuration, JSON:API-shaped operational responses, structured logging, health checks, PostgreSQL/Prisma, Redis, and BullMQ. It owns no voucher, order, payment, allocation, communication, stock, or result-checking tables.

The product engineering pack, when supplied locally as eduvoucher-engineering-docs, is intentionally ignored and never published from this repository. It defines detailed product scope, ADRs, unit specifications, test strategy, security controls, and operational runbooks. Read AGENTS.md before any product change.

## Compliance boundary

- NestJS runs on Fastify. HTTP APIs are versioned under /v1.
- Operational endpoints use a JSON:API-shaped data/errors envelope with a correlation ID. Responses and errors use `application/vnd.api+json`; ordinary request bodies use `application/json` with the endpoint's documented flat schema. A non-JSON body format, such as the administrative CSV import, must declare its own media type explicitly. Product teams must deliberately implement and document the applicable contract for feature endpoints.
- openapi.json exposes the generated OpenAPI contract.
- health/live verifies liveness without dependency access.
- health/ready runs PostgreSQL SELECT 1 and Redis PING concurrently; failure returns DEPENDENCY_UNAVAILABLE without connection details.
- PostgreSQL is authoritative; Redis/BullMQ are delivery and orchestration layers only.

Readiness takes O(1) time and O(1) memory: two constant-size checks run in parallel, create no records, and scan no application data.

## Before implementing a product unit

State its module owner, applicable invariant IDs, authorisation/privacy boundary, data model and constraints, index plan, expected scale/complexity, transaction/concurrency behavior, idempotency, failure/recovery behavior, outbox events, metrics/alerts, and acceptance tests. Preserve the approved sequence: catalog, import, orders, payment, fulfilment, allocation, backlog/restock, communication, stock, administration, and reconciliation.

## Verification

Run Nx sync check, lint, tests, build, and format check. With Compose PostgreSQL and Redis running, also run the public-api and admin-api end-to-end suites.
