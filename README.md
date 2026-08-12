# Check Result Portal Education API

Backend platform for the Check Result Portal education product. It is an Nx monorepo built with NestJS, Fastify, PostgreSQL/Prisma, Redis, BullMQ, structured logging, health checks, and generated OpenAPI.

## Applications

| Application  | Purpose                                          | Default port |
| ------------ | ------------------------------------------------ | ------------ |
| `public-api` | Public HTTP workflows                            | 3001         |
| `admin-api`  | Privileged and internal HTTP workflows           | 3002         |
| `worker`     | Background and scheduled work; no HTTP endpoints | —            |

Both HTTP APIs expose:

- `GET /v1/health/live` for process liveness
- `GET /v1/health/ready` for PostgreSQL and Redis readiness
- `GET /v1/openapi.json` for the generated OpenAPI document

## Local development

Install Node.js 22+ and pnpm 10, then:

```bash
pnpm install
docker compose up -d postgres redis
pnpm exec nx serve public-api
pnpm exec nx serve admin-api
pnpm exec nx serve worker
```

Copy the root and application `.env.example` files to local `.env` files before running an application. Never commit local `.env` files.

## Platform boundaries

- `libs/shared/*` owns reusable technical capabilities, never education business rules or education tables.
- Education modules own their write operations, constraints, persistence models, and public contracts; controllers remain thin.
- PostgreSQL is authoritative. Redis and BullMQ are delivery and performance layers, not sources of correctness.
- Define authentication, authorisation, tenant isolation, privacy, audit, data retention, and recovery requirements before introducing sensitive education data or result workflows.

## Quality checks

```bash
pnpm lint
pnpm test
pnpm build
pnpm format:check
```

See [education API foundation notes](docs/education-api-foundation.md) for the architectural standards and verification requirements.
