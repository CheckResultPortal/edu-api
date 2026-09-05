# Deployment build performance

Owner: build and deployment tooling. This change preserves payment, allocation,
worker recovery, privacy and migration behavior. There are no data, index,
transaction, event or API changes. Build caches hold compiler output and packages;
environment secrets remain excluded from the Docker context.

Observed in the original Dockerfile: copying all Prisma files before installing
dependencies invalidates installation after migration edits; Nx results disappear
between source-changing Docker builds; the runtime repeats OS/tool setup.
Public API already disables the duplicate forked TypeScript checker because of a
documented hang, while admin and worker still enable it.

The supplied failed worker log confirms a daemon project-graph error after
successful compilation, 1341 seconds in the build step, zero Nx cache hits,
and 280 seconds copying node_modules. These operations partly overlap.

Use a shared OS/tool stage, install before copying Prisma, retain package and Nx
caches with BuildKit, and run a separate typecheck before bundling all three apps.
Disable the duplicate forked checker consistently. Build tasks default to one at
a time to limit memory pressure on a server also running production containers.
The concurrency is configurable with EDU_BUILD_PARALLEL.
Reuse the dependency stage as the runtime parent to avoid copying node_modules
again. Prisma generation uses a fixed dummy URL rather than an overridable
DATABASE_URL build argument. Actual provider/database credentials must be runtime
variables in Coolify, not automatically injected build arguments.

Coolify must retain Docker build cache and use a persistent BuildKit builder.
Cache eviction is safe: it causes a cold rebuild. The first deployment after this
Dockerfile change may be cold. Avoid simultaneous API/admin/worker deployments
on a small server. No speed target is claimed without deployment timings.

Validation: typecheck and production builds of all three apps; inspect cold and
warm Docker builds with --progress=plain and compare install, typecheck, compile
and image-export timings. Check startup health after deployment. Docker execution
requires a running local engine. Revert these build files to roll back; no database
rollback is needed. Runtime dependency pruning is deferred until its generated
dependency manifest and Prisma migration dependencies can be tested in Docker.

References: https://docs.docker.com/build/cache/optimize/ and
https://nx.dev/docs/reference/environment-variables.
