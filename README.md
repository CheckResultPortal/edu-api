# NestJS Fastify Template

A production-minded backend starter built as an Nx monorepo with NestJS, Fastify, PostgreSQL/Prisma, Redis, BullMQ, structured logging, health checks, and OpenAPI generation. It deliberately contains no product-domain tables or workflows.

## Included applications

| Application  | Purpose                                          | Default port |
| ------------ | ------------------------------------------------ | ------------ |
| `public-api` | Internet-facing HTTP API boundary                | 3001         |
| `admin-api`  | Privileged or internal HTTP API boundary         | 3002         |
| `worker`     | Background and scheduled work; no HTTP endpoints | —            |

`public-api` and `admin-api` are example boundaries, not required product domains. Keep the ones your product needs, or add a purpose-specific app.

Both HTTP APIs expose:

- `GET /v1/health/live` for process liveness
- `GET /v1/health/ready` for PostgreSQL and Redis readiness
- `GET /v1/openapi.json` for the generated OpenAPI document

## Start a new product

1. Replace the template identity in `package.json`, `.env.example`, Docker Compose values, and the `@template/*` TypeScript aliases in `tsconfig.base.json`.
2. Copy each application `.env.example` to `.env` and set local credentials.
3. Create product modules outside `libs/shared/*`; each module owns its models, migrations, application logic, and API contracts.
4. Retain, rename, or remove the example app boundaries to match the product.

## Local development

Install Node.js 22+ and pnpm 10, then:

```bash
pnpm install
docker compose up -d postgres redis
pnpm exec nx serve public-api
pnpm exec nx serve admin-api
pnpm exec nx serve worker
```

## Quality checks

```bash
pnpm lint
pnpm test
pnpm build
pnpm format:check
```

## Template boundaries

- `libs/shared/*` owns only reusable technical capabilities, never product business rules or product tables.
- Domain modules own their write operations, constraints, and persistence models; controllers remain thin.
- PostgreSQL is authoritative. Redis and BullMQ are delivery/performance layers, not sources of correctness.
- External systems belong behind adapters, and each template copy must define its own authorisation, tenant-isolation, privacy, audit, and recovery policies.
