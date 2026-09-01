# =============================================================================
# Multi-stage Dockerfile for EduVoucher Nx monorepo
# Build: docker build --build-arg EDU_APP_NAME=public-api -t edu-api .
# =============================================================================

# ---- Base: install all dependencies + generate Prisma client ----
FROM node:22-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml prisma.config.ts ./
COPY prisma ./prisma

RUN pnpm install --frozen-lockfile

# prisma generate only reads the config; no real connection is made.
ARG DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy"
RUN DATABASE_URL="$DATABASE_URL" pnpm exec prisma generate

# ---- Build: compile the target app with Nx ----
FROM base AS build

ARG EDU_APP_NAME=public-api

COPY tsconfig.json tsconfig.base.json nx.json ./
COPY libs ./libs
COPY apps ./apps

RUN pnpm exec nx build ${EDU_APP_NAME} --configuration=production

# ---- Production: minimal runtime image ----
FROM node:22-slim AS production

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ARG EDU_APP_NAME=public-api

# Copy only what's needed at runtime
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/prisma ./prisma
COPY --from=base /app/prisma.config.ts ./prisma.config.ts
COPY --from=build /app/dist/apps/${EDU_APP_NAME} ./dist

ENV NODE_ENV=production

USER node

CMD ["sh", "-c", "pnpm exec prisma migrate deploy && node dist/main.js"]
