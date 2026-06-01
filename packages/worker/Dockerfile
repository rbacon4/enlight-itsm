FROM node:20-alpine AS base
RUN corepack enable pnpm
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY shared/package.json ./shared/
COPY packages/api/package.json ./packages/api/
COPY packages/worker/package.json ./packages/worker/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/worker/node_modules ./packages/worker/node_modules
COPY tsconfig.base.json ./
COPY shared/ ./shared/
COPY packages/api/ ./packages/api/
COPY packages/worker/ ./packages/worker/
RUN pnpm --filter @enlight/shared build
RUN pnpm --filter @enlight/worker build

FROM base AS runner
ENV NODE_ENV=production
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/packages/api/dist ./packages/api/dist
COPY --from=build /app/packages/worker/dist ./packages/worker/dist
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/worker/node_modules ./packages/worker/node_modules
WORKDIR /app/packages/worker
CMD ["node", "dist/index.js"]
