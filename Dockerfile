ARG NODE_IMAGE=node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
FROM ${NODE_IMAGE} AS base
WORKDIR /usr/app
RUN npm install -g pnpm@10.7.1
COPY package.json pnpm-lock.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile
COPY library ./library
COPY src ./src
COPY swagger.json ./swagger.json
COPY nodemon.json ./nodemon.json
COPY scripts/copy-facebook-assets.cjs ./scripts/copy-facebook-assets.cjs
RUN pnpm run build

FROM base AS development
EXPOSE 8000
CMD ["pnpm", "run", "dev"]

FROM ${NODE_IMAGE} AS production
WORKDIR /usr/app
RUN npm install -g pnpm@10.7.1
ENV NODE_ENV=production
ENV PORT=8000
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY --from=base /usr/app/dist ./dist
COPY start-all.sh ./start-all.sh
RUN mkdir -p uploads && chmod +x start-all.sh
EXPOSE 8000
CMD ["./start-all.sh"]
