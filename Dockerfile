# Base Node.js image
FROM node:20.15.0-alpine AS base

WORKDIR /usr/app

# Install a pinned pnpm version
RUN npm install -g pnpm@10.12.1

# Allow required dependency build scripts
RUN pnpm config set dangerouslyAllowAllBuilds true

# Copy package files first
COPY package.json tsconfig.json ./
COPY library ./library

# Install ALL dependencies
RUN pnpm install

# Copy source code
COPY src ./src
COPY scripts/copy-facebook-assets.cjs ./scripts/copy-facebook-assets.cjs

# Build TypeScript
RUN pnpm run build

# Verify dist folder
RUN ls -la dist/


# Stage 1: Development
FROM base AS development

EXPOSE 8000

CMD ["pnpm", "run", "dev"]


# Stage 2: Production
FROM node:20.15.0-alpine AS production

WORKDIR /usr/app

# Install the same pnpm version
RUN npm install -g pnpm@10.12.1

# Allow dependency build scripts
RUN pnpm config set dangerouslyAllowAllBuilds true

# Copy package files
COPY package.json tsconfig.json ./
COPY library ./library

# Install production dependencies
RUN pnpm install --prod

# Copy compiled application
COPY --from=base /usr/app/dist ./dist

ENV PORT=8000

EXPOSE 8000

RUN mkdir -p /usr/app/uploads

COPY start-all.sh ./
RUN chmod +x start-all.sh

CMD ["./start-all.sh"]
