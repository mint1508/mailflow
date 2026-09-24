ARG NODE_BASE=node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
FROM --platform=$BUILDPLATFORM ${NODE_BASE} AS deps

WORKDIR /app

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

FROM ${NODE_BASE} AS runtime

WORKDIR /app

ARG BUILD_SHA
ARG APP_VERSION
ARG UPSTREAM_SHA
ENV BUILD_SHA=${BUILD_SHA:-dev}
ENV APP_VERSION=${APP_VERSION:-}
ENV UPSTREAM_SHA=${UPSTREAM_SHA:-unknown}

COPY --from=deps /app/node_modules ./node_modules
COPY . /repo
RUN cp /repo/backend/package.json ./package.json && \
    cp -R /repo/backend/src ./src && \
    cp -R /repo/backend/migrations ./migrations && \
    APP_VERSION_VALUE="${APP_VERSION:-$(node -p "require('./package.json').version")}"; \
    APP_VERSION_VALUE="$(printf '%s' "$APP_VERSION_VALUE" | sed 's/^v[.]//' | sed 's/^v//')"; \
    printf '{"version":"%s"}\n' "$APP_VERSION_VALUE" > ./build-meta.json && \
    chown -R node:node /app && \
    rm -rf /repo

USER node

EXPOSE 3000

CMD ["node", "src/index.js"]
