# syntax=docker/dockerfile:1
# =============================================================================
# Multi-stage Dockerfile for EduVoucher Nx monorepo
# Build: docker build --build-arg EDU_APP_NAME=public-api -t edu-api .
# =============================================================================

# ---- Base: install all dependencies + generate Prisma client ----
FROM node:22-slim AS tooling

RUN apt-get update && apt-get install -y --no-install-recommends openssl curl && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

FROM tooling AS base

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./

RUN --mount=type=cache,id=edu-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store

COPY prisma.config.ts ./
COPY prisma ./prisma

# prisma generate only reads the config; no real connection is made.
RUN DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" pnpm exec prisma generate

# ---- Build: compile the target app with Nx ----
FROM base AS build

ARG EDU_APP_NAME=public-api
ARG EDU_BUILD_PARALLEL=1
ENV NX_DAEMON=false NX_ISOLATE_PLUGINS=false

COPY tsconfig.json tsconfig.base.json nx.json ./
COPY libs ./libs
COPY apps ./apps

RUN --mount=type=cache,id=edu-nx-cache,target=/app/.nx/cache,sharing=locked \
    pnpm exec nx run ${EDU_APP_NAME}:typecheck --parallel=${EDU_BUILD_PARALLEL} --outputStyle=static && \
    pnpm exec nx build ${EDU_APP_NAME} --configuration=production --parallel=${EDU_BUILD_PARALLEL} --outputStyle=static

# ---- Production: minimal runtime image ----
FROM base AS production

WORKDIR /app

ARG EDU_APP_NAME=public-api

# Reuse installed dependency layers rather than copying node_modules again.
# Application source and compiler output are confined to the build stage.
COPY --from=build /app/dist/apps/${EDU_APP_NAME} ./dist

ENV NODE_ENV=production

USER node

CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && node dist/main.js"]
