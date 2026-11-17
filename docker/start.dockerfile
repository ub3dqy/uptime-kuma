ARG NODE_VERSION=24.22.3
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
RUN apt-get update && \
    apt-get install --yes --no-install-recommends ca-certificates chromium fonts-noto-core iputils-ping && \
    rm -rf /var/lib/apt/lists/* && \
    install -d -o node -g node -m 0755 /app && \
    install -d -o node -g node -m 0700 /app/data
WORKDIR /app

FROM runtime AS dependencies
RUN apt-get update && \
    apt-get install --yes --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*
RUN npm install --global --ignore-scripts --no-audit --no-fund --min-release-age=14 npm@12.2.1
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1
USER node
COPY --chown=node:node .npmrc package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund --offline

FROM dependencies AS build
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node server ./server
COPY --chown=node:node db ./db
COPY --chown=node:node config ./config
COPY --chown=node:node extra ./extra
COPY --chown=node:node index.html LICENSE ./
RUN npm run build

FROM runtime AS release
LABEL org.opencontainers.image.source="https://github.com/ub3dqy/uptime-kuma"
ENV NODE_ENV=production UPTIME_KUMA_IS_CONTAINER=1 UPTIME_KUMA_ENABLE_EMBEDDED_MARIADB=0 UPTIME_KUMA_DISABLE_JSONATA=1
COPY --chown=node:node --from=production-dependencies /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/package.json /app/package-lock.json /app/LICENSE ./
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/server ./server
COPY --chown=node:node --from=build /app/src ./src
COPY --chown=node:node --from=build /app/db ./db
COPY --chown=node:node --from=build /app/extra ./extra
COPY --chown=node:node --from=build /app/config ./config
USER node
EXPOSE 3001
CMD ["node", "server/server.js"]
