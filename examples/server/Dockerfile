# ----- builder -----
FROM node:20-alpine AS builder
WORKDIR /build

# Install mindoodb (root) dependencies
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Build mindoodb library
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Install server dependencies (all, including dev for TypeScript build)
WORKDIR /build/examples/server
COPY examples/server/package.json examples/server/package-lock.json ./
RUN npm ci --ignore-scripts

# Build server
COPY examples/server/tsconfig.json ./
COPY examples/server/src/ ./src/
RUN npx tsc

# Remove dev dependencies after build
RUN npm prune --omit=dev

# Make mindoodb resolvable as a node_modules package.
# The compiled server code uses require("mindoodb/...") paths that map
# into the library's dist/ tree.
RUN mkdir -p node_modules/mindoodb \
    && cp -r /build/dist/* node_modules/mindoodb/ \
    && printf '{"name":"mindoodb","main":"./node/index.js"}\n' \
       > node_modules/mindoodb/package.json

# Copy mindoodb runtime dependencies into the server's node_modules
RUN for pkg in @automerge @digitalmaas uuid tweetnacl node-forge base-x; do \
      [ -d "/build/node_modules/$pkg" ] && \
        cp -r "/build/node_modules/$pkg" node_modules/ ; \
    done; true

# ----- runtime -----
FROM node:20-alpine

RUN addgroup -S app && adduser -S app -G app
WORKDIR /app

COPY --from=builder --chown=app:app /build/examples/server/dist/ ./dist/
COPY --from=builder --chown=app:app /build/examples/server/node_modules/ ./node_modules/
COPY --from=builder --chown=app:app /build/examples/server/package.json ./

USER app

EXPOSE 1661
VOLUME /data

ENTRYPOINT ["node", "dist/server.js", "--data-dir", "/data"]
CMD []
