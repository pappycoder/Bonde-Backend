# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Bonde Backend - production image
# Multi-stage build using pnpm + corepack. Targets Node 22 LTS.
# ---------------------------------------------------------------------------

# Stage 1: install dependencies (including dev deps for build)
FROM node:22-alpine AS deps
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Stage 2: build the application
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Generate the Prisma client. no `.env` exists in the image, so a dummy
# DIRECT_URL satisfies prisma.config.ts; only migrations use a real URL.
RUN DIRECT_URL="postgresql://dummy:dummy@localhost:5432/dummy" pnpm exec prisma generate
RUN pnpm run build
RUN pnpm prune --prod

# Stage 3: production runtime
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

USER node
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3001)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" || exit 1

CMD ["node", "dist/main.js"]
