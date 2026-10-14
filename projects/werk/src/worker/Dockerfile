FROM node:24-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
COPY scripts/build.mjs scripts/build.mjs
COPY src/shared src/shared
COPY src/worker src/worker
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --ignore-scripts --workspaces=false --strict-ssl=true
RUN node scripts/build.mjs worker --dist-only

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /build/src/worker/dist ./
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 4100
VOLUME ["/data"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:4100/healthz',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "/app/worker/cli.js"]
CMD ["run", "--state-dir", "/data", "--status-host", "0.0.0.0", "--status-port", "4100"]
