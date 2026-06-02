# Production Dockerfile — multi-stage build for the API server only
# Frontend deploys separately (e.g., Cloudflare Pages)

# --- cs (code spelunker) builder ---
# Builds a patched, statically-linked `cs` binary for the search_code tool.
# Pinned to the v3.1.0 commit for reproducibility; the patch adds Luau
# declaration support (see docker/cs/luau-declarations.patch). cs vendors its
# dependencies, so the `go build` step is offline after the clone.
FROM golang:1.25-bookworm AS cs-builder
ARG CS_COMMIT=697e0bf194bbc7a4a877e5170c70618989fc92e7
WORKDIR /build
COPY docker/cs/luau-declarations.patch /tmp/luau-declarations.patch
RUN git clone https://github.com/boyter/cs.git src \
	&& cd src \
	&& git checkout "${CS_COMMIT}" \
	&& git apply /tmp/luau-declarations.patch \
	&& CGO_ENABLED=0 go build -mod=vendor -ldflags="-s -w" -o /usr/local/bin/cs . \
	&& /usr/local/bin/cs --version

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

# Bundle the patched `cs` code-search binary for the search_code tool
COPY --from=cs-builder /usr/local/bin/cs /usr/local/bin/cs

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
