# Backend Template Agent Rules

Read this file before inspecting, planning, editing, testing, staging, or committing product work.

## Purpose and standards

This repository is a reusable Nx, NestJS, and Fastify backend template. Shared libraries provide configuration, JSON:API-shaped operational responses, OpenAPI, Prisma/PostgreSQL, Redis, BullMQ, health checks, and structured logging. They do not contain product business rules or product data models.

- Preserve strict TypeScript: no `any` in production code. Validate `unknown` at external boundaries and avoid unjustified casts.
- PostgreSQL is authoritative. Redis, queues, caches, and projections are never the only source of correctness.
- Use Prisma deliberately for PostgreSQL. Use BullMQ behind application adapters for background work. New public contracts must deliberately comply with the selected API standard and describe any compliance boundary.
- Generated OpenAPI remains available at `/v1/openapi.json`; health endpoints remain versioned under `/v1/health`.

## Architecture

- Preserve the Nx modular monolith unless an ADR and operational evidence justify a service split.
- Keep NestJS controllers thin. Domain code must not import NestJS, Prisma, Redis, HTTP clients, queues, or provider SDKs.
- A product module owns its tables, migrations, invariants, repositories, and write operations. Do not mutate another module's tables directly.
- Put reusable technical code in a specifically named shared library. Do not use generic `common`, `utils`, or `helpers` folders as business-logic dumping grounds.
- External providers belong behind adapters or anti-corruption layers.

## Product work

Before changing a product feature, identify its module owner, invariants, authorisation, tenant-isolation, data/privacy classification, threat model, and acceptance tests. Record durable cross-module, persistence, or security decisions in a feature brief and ADR.

For critical writes, use database constraints and short atomic transactions. Make retry behavior and idempotency explicit. Workers must use bounded batches, idempotent job keys, bounded concurrency, backoff with jitter, and dead-letter handling. Do not load unbounded tables into Node.js or add accidental quadratic work; document expected size, complexity, indexes, and concurrency behavior for high-volume operations.

## Delivery and quality

Implement in this order: feature brief and acceptance criteria; threat/privacy review; domain model and constraints; migrations; commands and queries; persistence/adapters; API contract; tests; observability/recovery; documentation.

- Verify tenant isolation where applicable, idempotency and concurrency for critical writes, and safe error handling at public boundaries.
- Add correlation IDs, metrics/logs, alerts, and an operational recovery path for critical workflows.
- Run relevant lint, unit, integration, end-to-end, and build checks before hand-off. Do not claim completion solely because code compiles.
- Preserve existing user work. Do not reset, delete, reformat, stage, or commit unrelated files. Never commit credentials, `.env` files, dependencies, build output, coverage, or Nx cache.
