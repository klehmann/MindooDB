# MindooDB reference server (MindooDBServer).
# Build from repository root:
#   docker build -f src/node/server/Dockerfile -t mindoodb-server .

# Pinned to an exact Node.js LTS patch release so a rebuild always pulls the
# security-patched runtime instead of reusing a stale cached `node:<major>`
# image. Bump NODE_VERSION when Node.js publishes a security release.
ARG NODE_VERSION=24.22.1

FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /build

# corepack downloads the exact pnpm version pinned in package.json ("packageManager").
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
# The server image only needs the compiled Node output; avoid depending on
# repository helper scripts that may not be present in minimal deployment checkouts.
RUN pnpm exec tsc

# Production node_modules only. Two things happen here:
#  1. The HTTP stack and the optional Iroh N-API binding live in
#     peer/devDependencies (they are optional for library consumers), so they
#     are promoted to regular dependencies for the server image. `--update`
#     rebuilds this image; operators do not `pnpm add` on the host.
#  2. auto-install-peers is disabled so the optional React Native / Expo peer
#     packages recorded in the lockfile stay out of the server image.
RUN rm -rf node_modules \
  && pnpm add --save-prod --lockfile-only --config.auto-install-peers=false \
    express@^4.22.3 \
    cors@^2.8.6 \
    helmet@^8.3.0 \
    express-rate-limit@^8.7.1 \
    @number0/iroh@^1.0.0 \
  && pnpm install --prod --no-frozen-lockfile --ignore-scripts --config.auto-install-peers=false

FROM node:${NODE_VERSION}-alpine

RUN addgroup -S app && adduser -S app -G app
WORKDIR /app

COPY --from=builder --chown=app:app /build/package.json ./package.json
COPY --from=builder --chown=app:app /build/node_modules ./node_modules
COPY --from=builder --chown=app:app /build/dist ./dist

USER app

EXPOSE 1661
VOLUME /data

ENTRYPOINT ["node", "dist/node/server/server.js", "--data-dir", "/data"]
CMD []
