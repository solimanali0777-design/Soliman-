FROM debian:bookworm-slim AS canonical_source
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates unzip && rm -rf /var/lib/apt/lists/*
ADD https://cdn.creativeclaw.co/u/9e11c682/zips/44729648-9d8c-4bc5-91a5-6ed7e3815e65.zip /tmp/soly.zip
RUN echo "d6e34e05b55178bccf0abf5e8795bc126074724a0cea44e26227c8efd5cc5ac5  /tmp/soly.zip" | sha256sum -c - \
 && mkdir -p /canonical \
 && unzip -q /tmp/soly.zip -d /canonical \
 && test -f /canonical/SOLY_AI_PRO_RC22_FINAL_FULL_2026-09-23/Dockerfile

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY --from=canonical_source /canonical/SOLY_AI_PRO_RC22_FINAL_FULL_2026-09-23/package*.json ./
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=canonical_source /canonical/SOLY_AI_PRO_RC22_FINAL_FULL_2026-09-23/ ./
RUN npm run typecheck && npm run test:soly && npm run build:dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/api/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["npm","run","dev"]
