# One Bun process plus a data volume. The client is built in the first stage;
# the second carries only what the server reads at runtime.
FROM oven/bun:1.3 AS build
WORKDIR /app
# Served from the root of its own hostname here, not under /race-tracker. Set in
# both stages: the first bakes it into the client bundle, the second is the
# server's route prefix and cookie path.
ENV RACE_TRACKER_BASE_PATH=""
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.3-slim
WORKDIR /app
COPY --from=build /app/package.json /app/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist
COPY --from=build /app/src ./src
COPY --from=build /app/tools ./tools
COPY --from=build /app/tsconfig.json ./

# The volume mounts here (fly.toml). Everything the event owns lives under it.
ENV RACE_TRACKER_DATA_DIR=/data
ENV RACE_TRACKER_BASE_PATH=""
EXPOSE 58013
CMD ["bun", "run", "src/server/index.ts"]
