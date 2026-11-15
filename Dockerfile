FROM node:24-slim
ENV CI=true
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
USER node
EXPOSE 4000
CMD ["pnpm", "--filter", "@novate/api", "exec", "tsx", "src/server.ts"]
