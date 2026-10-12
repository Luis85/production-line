FROM node:24-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
COPY scripts/build.mjs scripts/build.mjs
COPY src/shared src/shared
COPY src/factory src/factory
COPY src/guide src/guide
RUN node scripts/build.mjs factory

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /build/src/factory/dist ./
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3100
VOLUME ["/data"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3100/healthz',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "/app/factory/cli.js"]
CMD ["serve", "--host", "0.0.0.0", "--port", "3100", "--db", "/data/factory.sqlite"]
