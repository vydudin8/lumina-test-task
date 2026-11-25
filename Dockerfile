FROM node:26-slim AS base
RUN npm install -g pnpm@11.28.9
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# Browsers in this image match the pinned @playwright/test version.
FROM mcr.microsoft.com/playwright:v1.65.1-noble AS test
RUN npm install -g pnpm@11.28.9
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
CMD ["pnpm", "test:all"]

# Last stage, so a plain `docker build` (Railway, Render) builds the app image, not the test runner.
# Node runs the TypeScript sources directly (type stripping), so there is no server build step.
FROM base AS runtime
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY src ./src
COPY fixtures ./fixtures
COPY --from=build /app/dist ./dist
EXPOSE 3000
# npm passes SIGTERM to its script, and the script execs the server, so a stop reaches it (see src/server/main.ts).
CMD ["npm", "start"]
