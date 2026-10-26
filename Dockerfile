# The server, and the client CI built beside it. Nothing is compiled here --
# Bun runs the TypeScript, and the client arrives built -- so one stage.
# ⚠️ No default for BUN_VERSION: CI passes it from packageManager in
# package.json, which is then the only place the version is written.
ARG BUN_VERSION
FROM oven/bun:${BUN_VERSION}-slim

WORKDIR /app
ENV NODE_ENV=production

# Manifests first, so the install is cached until a dependency changes. Every
# workspace's manifest, since the lockfile names them all; only the server's
# runtime dependencies are installed, and they are installed here, never
# copied -- the isolated linker's node_modules are links into a store.
COPY package.json bun.lock bunfig.toml ./
COPY packages/server/package.json packages/server/
COPY packages/shared/package.json packages/shared/
COPY packages/client/package.json packages/client/
RUN bun install --frozen-lockfile --production --filter @wargame/server

COPY packages/shared/src packages/shared/src
COPY packages/server/src packages/server/src
COPY packages/server/drizzle packages/server/drizzle
COPY packages/client/dist packages/client/dist

# This release's build number, which the server reports on every answer. A
# deploy that names none is build 0, as an unset BUILD is everywhere else.
ARG BUILD=0
ENV BUILD=${BUILD}

USER bun
CMD ["bun", "packages/server/src/http.ts"]
