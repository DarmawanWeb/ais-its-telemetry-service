# syntax=docker/dockerfile:1.7
#
# ais-its-telemetry-service image (docs/PLATFORM_SPEC.md §11). Registry credentials only
# arrive as BuildKit secrets, never as build arguments or layers:
#   - npmrc (required): an .npmrc mapping @darmawanweb to its registry with a token
#   - ca (optional): an extra CA bundle for TLS-intercepting proxies
#
#   DOCKER_BUILDKIT=1 docker build --secret id=npmrc,src=$HOME/.npmrc -t ais-its-telemetry-service .
#   # behind a TLS-intercepting proxy (corepack downloads pnpm, pnpm fetches packages):
#   DOCKER_BUILDKIT=1 docker build --network host --secret id=npmrc,src=$HOME/.npmrc \
#     --secret id=ca,src=/path/to/ca-bundle.crt -t ais-its-telemetry-service .

# --- base: Node.js with pnpm (version from package.json "packageManager") ------
FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    HUSKY=0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .pnpmfile.cjs ./
RUN --mount=type=secret,id=ca,target=/tmp/build-ca.crt,required=false \
    if [ -s /tmp/build-ca.crt ]; then export NODE_EXTRA_CA_CERTS=/tmp/build-ca.crt; fi; \
    corepack enable && corepack install

# --- build: all dependencies, compile TypeScript --------------------------------
FROM base AS build
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    --mount=type=secret,id=ca,target=/tmp/build-ca.crt,required=false \
    --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    if [ -s /tmp/build-ca.crt ]; then export NODE_EXTRA_CA_CERTS=/tmp/build-ca.crt; fi; \
    pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm run build

# --- prod-deps: production dependencies only -------------------------------------
FROM base AS prod-deps
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    --mount=type=secret,id=ca,target=/tmp/build-ca.crt,required=false \
    --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    if [ -s /tmp/build-ca.crt ]; then export NODE_EXTRA_CA_CERTS=/tmp/build-ca.crt; fi; \
    pnpm install --frozen-lockfile --prod --ignore-scripts

# --- runtime: non-root, production only -------------------------------------------
FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    HOST=0.0.0.0 \
    PORT=3005
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node migrations ./migrations
USER node
EXPOSE 3005
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/health/live" || exit 1
CMD ["node", "dist/main.js"]
