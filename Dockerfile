# =============================================================================
# Multi-stage Dockerfile for EduVoucher Nx monorepo
# Build: docker build --build-arg APP_NAME=public-api -t edu-api .
# =============================================================================

# ---- Base: install all dependencies + generate Prisma client ----
FROM node:22-slim AS base

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY prisma ./prisma

RUN pnpm install --frozen-lockfile
RUN pnpm exec prisma generate

# ---- Build: compile the target app with Nx ----
FROM base AS build

ARG APP_NAME

COPY tsconfig.base.json ./
COPY nx.json ./
COPY libs ./libs
COPY apps ./apps

RUN pnpm exec nx build ${APP_NAME} --configuration=production

# ---- Production: minimal runtime image ----
FROM node:22-slim AS production

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ARG APP_NAME

# Copy only what's needed at runtime
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/prisma ./prisma
COPY --from=build /app/dist/apps/${APP_NAME} ./dist

ENV NODE_ENV=production

USER node

CMD ["sh", "-c", "pnpm exec prisma migrate deploy && node dist/main.js"]
