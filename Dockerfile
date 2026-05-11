# pdf-zipper-v2: Node + Playwright + BullMQ
# Based on Debian Bookworm for Playwright compatibility

FROM node:20-bookworm

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Install Playwright OS deps + ffmpeg
RUN npx playwright install-deps chromium && \
    apt-get update && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Install Playwright browsers to a shared location accessible by non-root users
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
RUN mkdir -p /opt/playwright-browsers && \
    npx playwright install chromium && \
    chmod -R 755 /opt/playwright-browsers

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY helper-chrome-plugins ./helper-chrome-plugins

# Install dev dependencies for build, then remove them
RUN npm install --save-dev typescript @types/node @types/express @types/archiver && \
    npm run build && \
    npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=3002

# yt-dlp: kept in its own cache-bustable layer (after npm/build) so the weekly
# refresh cron can pull a fresh binary without re-running the TypeScript compile.
# Bump via: docker compose build --build-arg YT_DLP_CACHEBUST=$(date +%Y%m%d)
ARG YT_DLP_CACHEBUST=initial
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    /usr/local/bin/yt-dlp --version

EXPOSE 3002

# Browser runs headless (chromium_headless_shell), no Xvfb needed
CMD ["node", "--max-old-space-size=512", "dist/index.js"]
