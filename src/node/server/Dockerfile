# MindooDB reference server (MindooDBServer).
# Build from repository root:
#   docker build -f src/node/server/Dockerfile -t mindoodb-server .

FROM node:20-alpine AS builder
WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
# The server image only needs the compiled Node output; avoid depending on
# repository helper scripts that may not be present in minimal deployment checkouts.
RUN npx tsc

# Production node_modules only: reinstall from lockfile (library deps), then add
# the HTTP stack. Avoids `npm prune` leaving an inconsistent tree with npm 10.
RUN rm -rf node_modules \
  && npm ci --omit=dev --ignore-scripts \
  && npm install --no-package-lock \
    express@^4.18.2 \
    cors@^2.8.6 \
    helmet@^8.1.0 \
    express-rate-limit@^8.2.1

FROM node:20-alpine

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
