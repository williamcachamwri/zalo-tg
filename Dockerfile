FROM node:20-alpine

WORKDIR /app

# Install all dependencies (devDependencies needed for build)
COPY package*.json ./
COPY scripts ./scripts
RUN npm ci

# Build and then reinstall production-only dependencies
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc && \
    npm ci --only=production && \
    rm -rf src tsconfig.json

# Create non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

CMD ["node", "dist/index.js"]
