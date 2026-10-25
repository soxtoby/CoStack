FROM oven/bun:1.4.0 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build --logLevel warn && bun run bundle

# ndx downloads and runs .NET tool packages like the SDK's dnx, without the SDK.
# The pins are the SHA-512 package hashes nuget.org publishes for ndx 1.0.7.
FROM busybox:1.37 AS ndx
ARG TARGETARCH
RUN case "${TARGETARCH:-amd64}" in \
      amd64) rid=linux-x64 \
        sha512=ca4d22510de6ba9859887af0680916f7822dcd007d40e79d70b1b0cbf084d6ddd84fd946d23530fe14c6877a6e83519f25f38fc79217c855d1f8973d6921cfec ;; \
      arm64) rid=linux-arm64 \
        sha512=6c881fb0714a842b306a20614817a49969490d3f681d5b909d57730b5c585b5f2cb8e9f6442d38abf4bcfae54e91c0b6690b02dc5d4ee8b6fbacefb8908ed2a5 ;; \
      *) echo "No ndx package for $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && wget -q -O /ndx.nupkg "https://api.nuget.org/v3-flatcontainer/ndx.$rid/1.0.7/ndx.$rid.1.0.7.nupkg" \
    && echo "$sha512  /ndx.nupkg" | sha512sum -c -s \
    && unzip -q -j /ndx.nupkg "tools/any/$rid/ndx" -d /ndx \
    && chmod 755 /ndx/ndx

# The ASP.NET Core image carries both shared frameworks that framework-dependent
# tools such as seqcli need.
FROM mcr.microsoft.com/dotnet/aspnet:10.0.2-noble AS runtime
COPY --from=oven/bun:1.4.0 /usr/local/bin/bun /usr/local/bin/bun
COPY --from=ndx /ndx/ndx /usr/local/bin/ndx
# Bun runs as bunx when invoked by that name. STDIO Connections keep running
# `dnx`; ndx accepts the same arguments.
RUN ln -s bun /usr/local/bin/bunx && ln -s ndx /usr/local/bin/dnx
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    BUN_INSTALL_CACHE_DIR=/tmp/bun-cache
# STDIO servers start in /app, so it stays writable for them. Ownership is set
# while copying: a later `chown -R` would store every file a second time.
RUN useradd --create-home --uid 10001 costack && chown costack:costack /app
# The bundle carries every dependency, so the image ships no node_modules, and
# it finds dist/client and migrations next to itself.
COPY --chown=costack:costack --from=build /app/build ./
COPY --chown=costack:costack --from=build /app/dist/client ./dist/client
COPY --chown=costack:costack src/database/migrations ./migrations
USER 10001
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD ["bun", "-e", "const r=await fetch('http://127.0.0.1:3000/health');if(!r.ok)process.exit(1)"]
CMD ["bun", "server.js"]
