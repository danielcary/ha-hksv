FROM bluenviron/mediamtx:1.21.0 AS rtsp_fixture

FROM node:24-bookworm-slim AS media
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*

FROM node:24-bookworm-slim AS build
WORKDIR /engine
COPY engine/package*.json ./
RUN npm ci
COPY engine/tsconfig.json ./
COPY engine/src ./src
RUN npm run build && npm prune --omit=dev

FROM media AS runtime
WORKDIR /engine
COPY --from=build /engine/package.json ./
COPY --from=build /engine/node_modules ./node_modules
COPY --from=build /engine/dist ./dist
COPY engine/scripts ./scripts
ENV HKSV_DATA_DIR=/data
CMD ["node", "dist/index.js"]

FROM runtime AS tests
COPY --from=rtsp_fixture /mediamtx /usr/local/bin/mediamtx
COPY engine/test ./test
ENV HKSV_REQUIRE_FFMPEG=1
CMD ["node", "--test", "test/engine.test.mjs", "test/media.test.mjs", "test/runtime.test.mjs", "test/rtsp.test.mjs"]

FROM runtime AS production
