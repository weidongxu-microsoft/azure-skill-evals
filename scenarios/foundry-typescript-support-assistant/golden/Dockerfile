FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN npm install --global pnpm@10.26.0

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json eslint.config.js ./
COPY src ./src
COPY tests ./tests
RUN pnpm build && pnpm prune --prod

FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node materials ./materials
COPY --chown=node:node evaluation ./evaluation

USER node
EXPOSE 3000

CMD ["node", "dist/src/server-main.js"]
