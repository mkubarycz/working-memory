FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY control-plane ./control-plane
RUN npm run compile:control-plane

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    WM_CONTROL_PLANE_HOME=/data \
    WM_CONTROL_PLANE_HOST=0.0.0.0 \
    WM_CONTROL_PLANE_PORT=7717

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/out/control-plane ./out/control-plane

EXPOSE 7717
VOLUME ["/data"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:7717/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"]

CMD ["node", "--experimental-sqlite", "out/control-plane/index.js"]
