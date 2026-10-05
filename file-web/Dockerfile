FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
ARG FILE_BUILD_SHA=dev
ARG FILE_RELEASE_VERSION=dev
ARG NEXT_PUBLIC_FILE_API_URL
ARG NEXT_PUBLIC_FILE_DEV_USER_ID
ARG NEXT_PUBLIC_FILE_DEV_EMAIL
ARG NEXT_PUBLIC_FILE_DEV_ADMIN
ARG NEXT_PUBLIC_DEMO_MODE
ARG NEXT_PUBLIC_OIDC_LOGIN_URL
ARG NEXT_PUBLIC_OIDC_LOGOUT_URL
ENV NODE_ENV=production \
    NEXT_PUBLIC_FILE_API_URL=$NEXT_PUBLIC_FILE_API_URL \
    FILE_BUILD_SHA=$FILE_BUILD_SHA \
    FILE_RELEASE_VERSION=$FILE_RELEASE_VERSION \
    NEXT_PUBLIC_FILE_BUILD_SHA=$FILE_BUILD_SHA \
    NEXT_PUBLIC_FILE_DEV_USER_ID=$NEXT_PUBLIC_FILE_DEV_USER_ID \
    NEXT_PUBLIC_FILE_DEV_EMAIL=$NEXT_PUBLIC_FILE_DEV_EMAIL \
    NEXT_PUBLIC_FILE_DEV_ADMIN=$NEXT_PUBLIC_FILE_DEV_ADMIN \
    NEXT_PUBLIC_DEMO_MODE=$NEXT_PUBLIC_DEMO_MODE \
    NEXT_PUBLIC_OIDC_LOGIN_URL=$NEXT_PUBLIC_OIDC_LOGIN_URL \
    NEXT_PUBLIC_OIDC_LOGOUT_URL=$NEXT_PUBLIC_OIDC_LOGOUT_URL
COPY --from=deps /app/node_modules ./node_modules
COPY app ./app
COPY src ./src
COPY public ./public
COPY next.config.mjs eslint.config.js package.json ./
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ARG FILE_BUILD_SHA=dev
ARG FILE_RELEASE_VERSION=dev
LABEL org.opencontainers.image.revision="$FILE_BUILD_SHA" \
      org.opencontainers.image.version="$FILE_RELEASE_VERSION" \
      org.opencontainers.image.title="hippy-file-web"
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
ENV FILE_BUILD_SHA=$FILE_BUILD_SHA FILE_RELEASE_VERSION=$FILE_RELEASE_VERSION FILE_IMAGE_DIGEST=""
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
