FROM node:20-alpine AS base
RUN corepack enable pnpm
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY shared/package.json ./shared/
COPY packages/api/package.json ./packages/api/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/shared/node_modules ./shared/node_modules
COPY --from=deps /app/packages/api/node_modules ./packages/api/node_modules
COPY tsconfig.base.json ./
COPY shared/ ./shared/
COPY packages/api/ ./packages/api/
RUN pnpm --filter @enlight/shared build
RUN pnpm --filter @enlight/api build

FROM base AS runner
ENV NODE_ENV=production
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/packages/api/dist ./packages/api/dist
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/api/node_modules ./packages/api/node_modules
WORKDIR /app/packages/api
EXPOSE 3000
CMD ["node", "dist/index.js"]
