# 前端构建（国内镜像，海外可改回 node:22-alpine）
ARG NODE_IMAGE=docker.m.daocloud.io/library/node:22-alpine
FROM ${NODE_IMAGE} AS build
WORKDIR /app

# 国内网络可在 docker compose build 时覆盖：NPM_REGISTRY=https://registry.npmjs.org
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm config set registry "$NPM_REGISTRY" && npm i -g pnpm@10

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY index.html vite.config.mjs ./
COPY src ./src
COPY public ./public
RUN pnpm build

# 运行时：只带 Node 内置依赖，不需要 node_modules
FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data \
    TZ=Asia/Shanghai

COPY --from=build /app/dist ./dist
COPY bailian-proxy/server.js bailian-proxy/dingtalk.js bailian-proxy/config.example.json ./bailian-proxy/
RUN mkdir -p /data && chown -R node:node /data /app

USER node
EXPOSE 8787 8788

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "bailian-proxy/server.js"]
