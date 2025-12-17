# Use Node.js 24 image as base
FROM node:24-slim AS builder

# Set working directory inside the container
WORKDIR /app

# Set DATABASE_URL for Prisma (temporary for build, will be overridden at runtime)
ENV DATABASE_URL="file:/app/data/sqlite.db"

# Copy package files for better layer caching
COPY package*.json ./

# Install dependencies (including dev dependencies for build)
RUN npm ci

# Copy prisma schema
COPY prisma ./prisma/

# Generate Prisma client
RUN npx prisma generate

# Copy TypeScript configuration and source code
COPY tsconfig.json ./
COPY src ./src/

# Build the TypeScript application
RUN npm run build

# Compile seed file
RUN npx tsc prisma/seed.ts --outDir dist/prisma --target ES2020 --moduleResolution node --module esnext --esModuleInterop

# Production stage
FROM node:24-slim

# Install system dependencies for Playwright, Xvfb, and other tools
RUN apt-get update -y && apt-get install -y \
  # Essential tools
  openssl \
  git \
  curl \
  # Xvfb for virtual display
  xvfb \
  # Playwright browser dependencies
  libnss3 \
  libnspr4 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libdrm2 \
  libdbus-1-3 \
  libxkbcommon0 \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxrandr2 \
  libgbm1 \
  libpango-1.0-0 \
  libcairo2 \
  libasound2 \
  libatspi2.0-0 \
  libxshmfence1 \
  # Fonts
  fonts-liberation \
  fonts-noto-color-emoji \
  # Clean up
  && rm -rf /var/lib/apt/lists/*

# Install docker-compose (latest version)
RUN curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose \
  && chmod +x /usr/local/bin/docker-compose \
  && ln -s /usr/local/bin/docker-compose /usr/bin/docker-compose

WORKDIR /app

# Set DATABASE_URL for Prisma (will be overridden by .env file at runtime)
ENV DATABASE_URL="file:/app/data/sqlite.db"

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy Prisma files
COPY prisma ./prisma/

# Generate Prisma client in production
RUN npx prisma generate

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Copy templates directory
COPY templates ./templates/

# Copy legacy docker-compose file for legacy deployments
COPY legacy-docker-compose.yaml ./legacy-docker-compose.yaml

# Create directory for SQLite database
RUN mkdir -p /app/data

# Create SQLite database file
RUN touch /app/data/sqlite.db

# Set display for Xvfb
ENV DISPLAY=:99

# Install Playwright browsers (Firefox)
RUN npx playwright install firefox

# Create startup script that runs Xvfb and the application
RUN echo '#!/bin/sh\n\
  # Start Xvfb in the background\n\
  Xvfb :99 -screen 0 1280x720x24 -ac +extension GLX +render -noreset &\n\
  XVFB_PID=$!\n\
  echo "Started Xvfb with PID: $XVFB_PID"\n\
  \n\
  # Wait a moment for Xvfb to initialize\n\
  sleep 2\n\
  \n\
  # Run migrations, seed, and start the application\n\
  npx prisma migrate deploy && node dist/prisma/seed.js && npm start\n\
  \n\
  # Clean up Xvfb on exit\n\
  kill $XVFB_PID 2>/dev/null\n\
  ' > /app/start.sh && chmod +x /app/start.sh

# Start the application with Xvfb
CMD ["/app/start.sh"]
