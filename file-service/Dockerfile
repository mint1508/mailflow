FROM node:22-alpine
ARG FILE_BUILD_SHA=dev
ARG FILE_RELEASE_VERSION=dev
LABEL org.opencontainers.image.revision="$FILE_BUILD_SHA" \
      org.opencontainers.image.version="$FILE_RELEASE_VERSION" \
      org.opencontainers.image.title="hippy-file-service"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts
RUN mkdir -p /data && chown -R node:node /app /data
USER node
ENV NODE_ENV=production FILE_DATA_DIR=/data PORT=4310 FILE_AUTH_MODE=oidc \
    FILE_BUILD_SHA=$FILE_BUILD_SHA FILE_RELEASE_VERSION=$FILE_RELEASE_VERSION
EXPOSE 4310
CMD ["node", "src/server.js"]
