# EduVoucher / Check Result Portal Engineering Rules

Read this file before inspecting, planning, editing, testing, staging, or committing product work.

## Local authoritative reference pack

eduvoucher-engineering-docs is local reference material and is intentionally ignored: never stage, commit, or publish it from this repository. When present, it is the detailed source of truth.

Before product work, read in this order:

1. eduvoucher-engineering-docs/AGENTS.md
2. docs/00-product/BUSINESS_INVARIANTS.md
3. Relevant approved ADRs under docs/02-adr
4. The target unit specification under docs/03-specs
5. Relevant testing, operations, and security documents
6. Existing module boundaries, implementation, and tests

Authority order is approved business invariants, approved ADRs, unit specification, module-boundary rules, existing implementation/tests, then agent inference. Never override a higher-priority rule for implementation convenience. Never invent a business rule: record the gap and request a decision.

## Product scope and delivery order

Phase 1 is a high-availability, guest voucher-selling platform for WAEC result-checker demand. It includes web purchase, Moolre USSD purchase, verified web payments, secure voucher allocation, zero-stock paid backlog, automatic FIFO restock fulfilment, independent SMS/email communication, stock alerts, administration, audit, and reconciliation.

Build in this sequence only:

1. Catalog
2. Voucher batch import
3. Guest order creation
4. Payment provider integration
5. Fulfilment-unit creation
6. Secure voucher allocation
7. Zero-stock paid backlog
8. Restock drain
9. Communication
10. Stock alerts
11. Admin operations
12. Audit and reconciliation
13. Moolre USSD
14. Reliability and scale certification
15. Optional result-checking add-on

Customer accounts, university applications, agents/referrals, SMS failover, microservices, and result checking as a mandatory sale step are out of Phase 1. Result checking is a separate optional paid add-on and must never block voucher delivery.

## Non-negotiable invariants

### Voucher, allocation, payment, and checkout

- Voucher lifecycle is only AVAILABLE to SOLD in Phase 1. Do not add USED, REDEEMED, EXPIRED, VOIDED, QUARANTINED, RESERVED, or another state without an approved ADR. Batch validity controls allocation eligibility; it is not a voucher status.
- A sold voucher never returns to available because communication failed. A voucher has at most one allocation and a fulfilment unit has at most one allocation.
- Allocation occurs only after verified successful payment. Paid quantity creates the same number of fulfilment units exactly once.
- Zero stock does not reject valid payment or remove the fulfilment obligation. Waiting paid units are allocated deterministically by paidAt ascending then internal id ascending, even with concurrent workers.
- Checkout is guest based. Backend pricing is authoritative, client prices are ignored, and authoritative price is snapshotted at order creation.
- Frontend state is never payment proof. Verify provider authenticity, reference, amount, and currency before committing payment-success effects.
- Duplicate provider events never duplicate payment success, fulfilment units, allocations, outbox effects, or communication delivery.
- Critical public writes use idempotency keys: same key/payload returns the original result; same key/different payload is a conflict. Use opaque public references, not predictable internal IDs, for public contracts or authorisation.

### Communication, stock, and reconciliation

- SMS and email have independent delivery records, states, attempts, and retries. Retry and admin retry always reuse the existing allocation. Communication workers never allocate inventory.
- Automatic retries precede manual recovery. Admin retry is atomically claimed and idempotent. Unknown provider outcomes are not automatically safe failures or safe duplicates; reconcile via provider capabilities before an unsafe resend.
- Stock alerts are NORMAL, LOW, and EMPTY operational transitions, not voucher state. Alert once per depletion cycle, then reset after recovery.
- Reconciliation exposes mismatches and never silently rewrites history: imported vouchers equal available plus sold; paid voucher quantity equals allocated plus waiting; every sold voucher has exactly one allocation.

## Architecture and module ownership

- Preserve the Nx modular monolith with NestJS on Fastify. No microservice extraction without an approved ADR and measured evidence.
- Controllers are thin. Domain code never imports NestJS, Prisma, Redis, HTTP clients, queues, or provider SDKs.
- PostgreSQL is authoritative for orders, payments, fulfilment, allocation, voucher ownership, communication obligations, outbox, and reconciliation facts. Redis/BullMQ are orchestration, retry, cache, rate-limit, and transient-session infrastructure only.
- Durable events whose loss would break correctness use the Transactional Outbox in the same transaction as their state change. Consumers are idempotent; events carry references and non-secret metadata only.
- External network calls never run inside database transactions. Keep transactions short and protect critical state with constraints and database concurrency controls.
- Provider-native codes, requests, authentication, error formats, and Moolre semantics stay in adapters. Application code uses canonical statuses and failure categories.
- No circular dependencies, generic business-rule dumping grounds, or direct cross-module table mutation. Use module contracts, commands/events, and explicit read/query facades.

Module ownership is strict:

- Catalog: products, price, activation, low-stock threshold.
- Orders: guest lifecycle, contacts, price snapshots, items; never payment success.
- Payments: canonical payment state, provider verification/callback normalization, idempotency.
- Voucher inventory: batches, encrypted credentials, availability; never communications.
- Fulfilment: paid obligations and the only permanent allocation writer.
- Communication: purposes, channel deliveries, attempts; never allocation.
- Stock monitoring: low/empty transitions; not inventory truth.
- Reconciliation: reads cross-module facts; no silent transactional mutation.
- USSD: Moolre translation and canonical actions; reuse core flows.
- Administration: RBAC/audited operations through module contracts.

## Data, privacy, security, and performance

- Critical invariants require database constraints, indexes, and atomic transactions, not only TypeScript or in-memory locks.
- Use BIGINT internal IDs for hot transactional tables and opaque public IDs/references externally. Review indexes for every hot query. Paginate every unbounded list and use cursor/keyset pagination for operational data.
- Allocation uses short transactions with FOR UPDATE SKIP LOCKED, unique allocation constraints, indexed eligible voucher/waiting-unit selection, and no inventory scan. Restock/backlog work is bounded, benchmark-configured, chunked, FIFO, and bulk-written.
- Imports stream, validate, fingerprint, encrypt, bulk insert, and activate in bounded chunks. Never use a full in-memory import or one database create call per record.
- PINs never appear in plaintext database fields, Redis, BullMQ, logs, traces, audit events, analytics, queue payloads, or UI retry flows. Use authenticated encryption at rest and keyed/HMAC fingerprints for duplicate detection; decrypt only immediately before an approved send.
- Queue payloads carry IDs/references only. Do not synchronously update a global stock counter on every sale if it creates contention.
- Public APIs require HTTPS, strict schemas, rate controls, opaque references, idempotency, abuse controls, and server-authoritative prices/payments. No permanent browser API secret. CORS is not authentication.
- Admin APIs require authenticated sessions, RBAC, audit logging, and step-up/MFA where appropriate. High-risk actions include price changes, imports/activation, manual retry, reconciliation adjustments, and provider configuration.
- Webhooks use provider-specific server-to-server verification. Secrets are never committed, logged, returned in errors, or exposed to browsers; use deployment injection/secret management and documented rotation.

## Workers, recovery, observability, and operations

- Workers use bounded concurrency/batches, idempotent job keys, exponential backoff with jitter, dead-letter/needs-attention behavior, recovery sweepers, and safe retry classification.
- Redis outage, worker crash, database restart, duplicate callbacks, provider timeout, partial restock, and interrupted import must preserve PostgreSQL facts and recover through outbox/sweepers.
- Carry correlation/trace IDs and safe business references across requests/jobs. Use structured logs only.
- Track orders, payment outcomes, available/sold stock, waiting count/age, allocation duration, communication outcome by channel/provider, stock transitions, outbox age, queue depth, worker throughput, DB pool/lock pressure, and public API p95/p99/error rate.
- Alert on low/empty transition, excess/old paid backlog, payment or communication failure spikes, needs-attention growth, outbox/queue backlog, reconciliation mismatch, DB lock/pool pressure, and API budget breach.
- Never manually assign a replacement voucher for delivery failure, disable constraints for callback storms, or edit allocation ownership rows to clear a backlog.

## Required implementation workflow and definition of done

For every approved unit:

1. Write an implementation-impact note covering owner, invariants, authorisation/privacy, data/constraints/indexes, input size/time-space complexity, transactions/concurrency, idempotency, recovery, events, metrics/alerts, and acceptance tests.
2. Implement only the target unit and direct contracts.
3. Add schema constraints, indexes, migrations, and rollback/forward operational notes where applicable.
4. Add unit, PostgreSQL integration, provider contract, end-to-end, security, concurrency/idempotency, load, and failure-injection tests in proportion to the unit.
5. Update OpenAPI, event contracts, ADRs, and operational documentation when contracts or durable decisions change.
6. Run architecture checks, lint, typecheck, tests, and relevant verification commands.
7. Report changed files, invariants, tests, assumptions, and unresolved gaps.

A feature is not complete because it returns 200. Completion requires documented business rules/state transitions; constraints/indexes; transaction/idempotency/failure/recovery behavior; observability/audit; security review; acceptance criteria; migration review; and no silently invented policy.

## Forbidden shortcuts

- No provider-specific conditionals scattered through business services.
- No frontend-authoritative payment success.
- No second allocation for SMS/email failure.
- No in-memory-only protection for critical writes.
- No provider call in a database transaction.
- No unbounded database read over imports, backlog, stock, fulfilment, payments, or communication histories.
- No raw voucher PIN in a queue, log, trace, audit record, or UI retry flow.
- No destructive refactor outside the active approved unit without explicit approval.
