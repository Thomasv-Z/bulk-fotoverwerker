# Base image
FROM node:20-bookworm-slim

# Install image/RAW tooling (darktable-cli, rawtherapee-cli, libraw's dcraw_emu) and runtime deps
RUN apt-get update &&         DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends           darktable           rawtherapee           libraw-bin           exiftool           ca-certificates           curl           tini         && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Install dependencies first (cached)
COPY package*.json ./

# If you use private registries, add ARGs here (left commented intentionally)
# ARG NPM_TOKEN
# RUN echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > .npmrc

RUN npm ci --omit=dev

# Copy the rest
COPY . .

# Ensure uploads/storage directories exist
RUN mkdir -p /app/uploads /app/storage && chown -R node:node /app

# Switch to non-root
USER node

# Expose the server port
EXPOSE 3000

# Environment defaults
ENV NODE_ENV=production         PORT=3000

# Use tini as init for proper signal handling
ENTRYPOINT ["/usr/bin/tini", "--"]

# Start the server
CMD ["node", "server.js"]
