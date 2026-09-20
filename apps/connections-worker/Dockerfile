# The connections worker image. Build context is the REPO ROOT (CDK ContainerImage.fromAsset), so
# the worker's workspace deps (@emgloop/shared, @emgloop/database) are present. Staging.
#
# It installs the workspaces, generates the Prisma client for this platform, and runs the worker via
# tsx. Secrets are injected as environment variables by the Fargate task from Secrets Manager; none
# is baked into the image.
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

# Install all workspaces (the worker runs its TypeScript via tsx, a dev dependency).
RUN npm install --no-audit --no-fund

# Generate the Prisma client + the engine for this platform (a dummy URL is fine for generate).
RUN DATABASE_URL="postgresql://x:x@localhost:5432/x" npx prisma generate --schema packages/database/prisma/schema.prisma

ENV NODE_ENV=production \
    LOOP_CONNECTIONS_WORKER_RUN=1 \
    PORT=8080
EXPOSE 8080
CMD ["node", "--import", "tsx", "apps/connections-worker/src/index.ts"]
