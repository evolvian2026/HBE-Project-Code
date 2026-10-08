# syntax=docker/dockerfile:1.7
# One image for every role (ROLES=web,api,worker), used by Render (demo) and EC2 (production).
# See docs/DEPLOYMENT.md and docs/CONFIGURATION.md.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1 \
    TURBO_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

# ---- build ------------------------------------------------------------------
FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm --filter @hbe/web build \
 && pnpm --filter @hbe/server build \
 && rm -rf apps/web/.next/cache
# Production node_modules for the server (includes next/react for the web role).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @hbe/server deploy --prod --legacy /out

# ---- runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HBE_CONFIG_DIR=/app/config \
    WEB_DIR=/app/web \
    PORT=3000
WORKDIR /app

COPY --from=build --chown=node:node /out/ ./
COPY --from=build --chown=node:node /repo/apps/web/.next ./web/.next
COPY --from=build --chown=node:node /repo/apps/web/package.json /repo/apps/web/next.config.mjs ./web/
COPY --from=build --chown=node:node /repo/config/profiles ./config/profiles

USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
