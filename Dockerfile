FROM oven/bun:1.4.0 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM mcr.microsoft.com/dotnet/sdk:10.0.102-noble AS runtime
COPY --from=oven/bun:1.4.0 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DOTNET_CLI_HOME=/tmp/dotnet \
    BUN_INSTALL_CACHE_DIR=/tmp/bun-cache
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist
COPY server.ts ./server.ts
COPY src ./src
RUN useradd --create-home --uid 10001 costack && chown -R costack:costack /app
USER 10001
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD ["bun", "-e", "const r=await fetch('http://127.0.0.1:3000/health');if(!r.ok)process.exit(1)"]
CMD ["bun", "run", "server.ts"]
