FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/claude-plugin/package.json packages/claude-plugin/
COPY packages/platform/package.json packages/platform/
RUN npm ci
COPY packages/platform packages/platform
RUN npm run build

FROM node:20-bookworm-slim
ENV NODE_ENV=production DB_PATH=/data/monitor.db PORT=4318
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/claude-plugin/package.json packages/claude-plugin/
COPY packages/platform/package.json packages/platform/
RUN npm ci --omit=dev -w claude-monitor-platform && npm cache clean --force
COPY packages/platform/server packages/platform/server
COPY packages/platform/scripts packages/platform/scripts
COPY --from=build /app/packages/platform/dashboard/dist packages/platform/dashboard/dist
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4318
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/platform/server/index.js"]
