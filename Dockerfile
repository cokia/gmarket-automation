FROM node:20-alpine AS base

# ─── Stage 1: Install core (batch-pay) dependencies ──────────────────────────
FROM base AS core-deps
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production

# ─── Stage 2: Install web dependencies ───────────────────────────────────────
FROM base AS web-deps
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci

# ─── Stage 3: Build Next.js ──────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app

COPY --from=core-deps /app/node_modules ./node_modules
COPY package.json yarn.lock batch-pay.ts ./
COPY sample/ ./sample/

COPY --from=web-deps /app/web/node_modules ./web/node_modules
COPY web/ ./web/

WORKDIR /app/web
RUN npm run build

# ─── Stage 4: Production image ───────────────────────────────────────────────
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV PROJECT_ROOT=/app

RUN apk add --no-cache libc6-compat

COPY --from=builder /app/web/.next/standalone ./
COPY --from=builder /app/web/.next/static ./web/.next/static
COPY --from=builder /app/web/public ./web/public

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/batch-pay.ts ./batch-pay.ts
COPY --from=builder /app/sample ./sample
COPY --from=builder /app/package.json ./package.json

RUN mkdir -p /app/results /app/results/logs /app/.tokens

EXPOSE 3000

CMD ["sh", "-c", "HOSTNAME=0.0.0.0 node web/server.js"]
