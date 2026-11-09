# Production image. Run with docker-compose.prod.yml (docs/guides/PRODUCTION_RUN.md).

# build: full dependencies, compiled dist/, Prisma client. Also runs migrations
# (the `migrate` service in docker-compose.prod.yml), so the runtime stays slim.
FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The app starts workspace containers on the host's Docker through the mounted socket.
COPY --from=docker:27.5.1-cli /usr/local/bin/docker /usr/local/bin/docker
# The Dev Container CLI builds devcontainers with buildx (features) and Compose.
COPY --from=docker/buildx-bin:0.20.1 /buildx /usr/libexec/docker/cli-plugins/docker-buildx
COPY --from=docker/compose-bin:v2.32.4 /docker-compose /usr/libexec/docker/cli-plugins/docker-compose
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist
# Runs as root on purpose: workspace containers write files as root, which the
# app must edit and delete, and the Docker socket is root-equivalent anyway.
EXPOSE 3001
CMD ["node", "dist/index.js"]
