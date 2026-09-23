ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN useradd --create-home --shell /usr/sbin/nologin worker \
  && mkdir -p /workspace \
  && chown -R worker:worker /app /workspace
USER worker
ENV NODE_ENV=production
ENV WORK_DIR=/workspace
ENTRYPOINT ["node", "dist/index.js"]
CMD ["check"]
