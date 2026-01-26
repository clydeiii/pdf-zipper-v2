# pdf-zipper-v2: Node + Playwright + BullMQ
# Based on Debian Bookworm for Playwright compatibility

FROM node:20-bookworm

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Install Playwright OS deps + xvfb for virtual display
RUN npx playwright install-deps chromium && \
    apt-get update && \
    apt-get install -y xvfb xauth && \
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

# Install dev dependencies for build, then remove them
RUN npm install --save-dev typescript @types/node @types/express @types/archiver && \
    npm run build && \
    npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=3002

# Run in headed mode with virtual display (better site compatibility)
ENV HEADFUL=1
EXPOSE 3002

# Use xvfb-run to provide a virtual display for headed Chrome
CMD xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" node dist/index.js
