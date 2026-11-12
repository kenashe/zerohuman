# ZeroHuman seller — Railway background worker (also runs anywhere Docker does).
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
ENV NODE_ENV=production \
    DATABASE_PATH=/data/zerohuman.db \
    DASHBOARD_DIR=/app/dashboard
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY dashboard ./dashboard
COPY schemas ./schemas
# Runs as the unprivileged `node` user. If the mounted volume is not writable on your
# host, see docs/DEPLOYMENT.md ("Volume permissions").
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "dist/seller/main.js"]
