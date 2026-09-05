# Library build cache output ownership

## Implementation impact

The platform build configuration owns this repair. Nx inferred the entire shared
`dist/out-tsc` tree as the output of every library. Restoring an unrelated cached
library could therefore overwrite current Prisma declarations with older types.

Each library now caches only `dist/out-tsc/{projectRoot}`. The database library
also owns `dist/out-tsc/generated/prisma`. Existing inferred commands, dependency
ordering, and inputs are retained. No product rules, authorisation, secrets,
database schema, indexes, transactions, concurrency, idempotency, durable events,
recovery workers, or metrics/alerts change. Work is bounded by the existing source
tree; narrower cache archives avoid copying unrelated compilation output.

## Verification and recovery

Force-rebuild the Communication TypeScript project and its references once to
repair existing declarations. Build worker and admin-api with caching enabled,
then repeat to exercise cache reuse. Run existing Communication and worker tests,
and configuration formatting checks. Inspect resolved Nx outputs to ensure each
library has exclusive cache ownership. No database migration is required.

If reverting this configuration, use `--skip-nx-cache` until output ownership is
corrected; old cache restores can otherwise reintroduce stale declarations.

Verified locally: worker and admin-api builds passed, followed by a successful
repeat with 20/20 cache hits. Database, Communication, and worker tests passed
(18 passed, 2 skipped); their lint checks passed with four existing Communication
warnings. Formatting passed. The database test run also reported a Jest worker
teardown warning. Live provider delivery and database integration were not run
for this build-only repair.
