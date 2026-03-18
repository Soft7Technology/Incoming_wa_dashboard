# Base Node.js image
FROM node:20.15.0-alpine AS base

# Set working directory
WORKDIR /usr/app

# Install pnpm globally
RUN npm install -g pnpm

# Copy package files first
COPY package.json tsconfig.json ./
COPY library ./library

# Install ALL dependencies (needed for building)
RUN pnpm install

# Copy source code (this will NOT overwrite node_modules due to .dockerignore)
COPY src ./src

# Build TypeScript to JavaScript
RUN pnpm run build

# Verify dist folder was created (optional debug step)
RUN ls -la dist/

# Stage 1: Development environment
FROM base AS development

# Expose port
EXPOSE 8000

# Use dev command (runs TypeScript directly with ts-node)
CMD ["pnpm", "run", "dev"]

# Stage 2: Production environment  
FROM node:20.15.0-alpine AS production

# Set working directory
WORKDIR /usr/app

# Install pnpm globally
RUN npm install -g pnpm

# Copy package files
COPY package.json tsconfig.json ./
COPY library ./library

# Install only production dependencies
RUN pnpm install --production

# Copy the built dist folder from base stage
COPY --from=base /usr/app/dist ./dist

# Set the PORT environment variable for production
ENV PORT=8000

# Expose port
EXPOSE 8000

# Ensure uploads directory exists
RUN mkdir -p /usr/app/uploads

# Run the built JavaScript files
# CMD ["pnpm", "start"]

COPY start-all.sh ./
RUN chmod +x start-all.sh

CMD ["./start-all.sh"]