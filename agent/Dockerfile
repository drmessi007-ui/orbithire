FROM node:22-alpine AS dependencies

WORKDIR /app/agent
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    SERVICE_HOST=0.0.0.0 \
    SERVICE_PORT=8787

WORKDIR /app/agent
COPY --from=dependencies --chown=node:node /app/agent/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node src/ ./src/
RUN mkdir -p /app/agent/data && chown -R node:node /app/agent

USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "src/index.js"]
