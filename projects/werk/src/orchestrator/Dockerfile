FROM node:24-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
# Optional BuildKit CA for trusted enterprise proxies; never retained in an image layer.
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --ignore-scripts --omit=dev --workspaces=false --strict-ssl=true
COPY scripts/build.mjs scripts/build.mjs
COPY src/shared src/shared
COPY src/orchestrator src/orchestrator
COPY src/guide src/guide
RUN node scripts/build.mjs orchestrator --dist-only

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /build/src/orchestrator/dist ./
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "/app/orchestrator/cli.js"]
CMD ["serve", "--host", "0.0.0.0", "--port", "3000", "--db", "/data/factory.sqlite", "--project", "demo"]
