# SiteInsight browser worker. Build from the REPOSITORY ROOT:
#   docker build -f worker/Dockerfile -t siteinsight-worker .
# The Playwright image ships Chromium and its system dependencies.
FROM mcr.microsoft.com/playwright:v1.64.0-noble

ENV NODE_ENV=production \
    PORT=8080 \
    WORKER_CONCURRENCY=2
WORKDIR /app

# Dependencies are installed at /app so both worker/ and the shared files in src/ resolve them.
COPY worker/package.json worker/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY worker/src ./worker/src
COPY src/lib/browser/protocol.ts ./src/lib/browser/protocol.ts
COPY src/lib/security/ip.ts ./src/lib/security/ip.ts

# Run as the unprivileged user provided by the image.
USER pwuser
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/livez').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "worker/src/main.ts"]
