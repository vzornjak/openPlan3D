# Open-Drawing — Docker build for the ArchiDrawing fork of laanlabs/openPlan3D
# Multi-stage: build with full Node/npm toolchain, run with a minimal image
# containing only the compiled output + production dependencies.

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NODE_ENV=production
RUN npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Runtime deps only — smaller image, no dev/build tooling in the final layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/build ./build
COPY --from=build /app/static ./static

# Run as the pre-existing non-root 'node' user (matches the home-infra
# convention of least-privilege containers — see oda-converter's compose.json).
USER node
EXPOSE 3000
ENV PORT=3000
ENV HOST=0.0.0.0
# adapter-node's own health surface is just "does it answer" — SvelteKit has
# no built-in /health endpoint, so probe the root page.
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/', r => process.exit(r.statusCode < 500 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["node", "build"]
