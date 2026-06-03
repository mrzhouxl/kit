FROM node:20-alpine AS builder

WORKDIR /app

RUN npm install -g pnpm@9.15.9

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build \
  && pnpm prune --prod

FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV TZ=Asia/Shanghai

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/skills ./src/skills
COPY --from=builder /app/public ./public

EXPOSE 3002

CMD ["node", "dist/index.js"]