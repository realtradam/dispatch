# Production Dockerfile — multi-stage build for the API server only
# Frontend deploys separately (e.g., Cloudflare Pages)

FROM oven/bun:1 AS builder

WORKDIR /app

COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/frontend/package.json packages/frontend/package.json

RUN bun install --frozen-lockfile

COPY . .

# --- Production image ---

FROM oven/bun:1

WORKDIR /app

# Copy only what the API server needs
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/core ./packages/core
COPY --from=builder /app/packages/api ./packages/api

# Create workspace directory for file tools
RUN mkdir -p workspace

# Production entrypoint
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Run as non-root
USER bun

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD bun -e "const r = await fetch('http://localhost:3000/health'); process.exit(r.ok ? 0 : 1)"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bun", "packages/api/src/index.ts"]
