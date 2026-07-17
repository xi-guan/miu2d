# 构建阶段
FROM node:24-bookworm-slim AS builder

# bun 只当包管理器, node 仍是运行时
COPY --from=oven/bun:1.3.14 /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# 复制 workspace 配置文件
COPY bun.lock package.json ./
COPY tsconfig.base.json ./

# bun --frozen-lockfile 要求 lockfile 里全部 workspace 成员的 package.json 在场
COPY packages/converter/package.json ./packages/converter/
COPY packages/dashboard/package.json ./packages/dashboard/
COPY packages/engine/package.json ./packages/engine/
COPY packages/engine-wasm/package.json ./packages/engine-wasm/
COPY packages/game/package.json ./packages/game/
COPY packages/ui/package.json ./packages/ui/
COPY packages/viewer/package.json ./packages/viewer/
COPY packages/web/package.json ./packages/web/

# 复制 types 包配置和源代码（server 依赖 types）
COPY packages/types/package.json ./packages/types/
COPY packages/types/tsconfig.json ./packages/types/
COPY packages/types/src ./packages/types/src

# 复制 shared 包配置和源代码（server 依赖 shared/locales）
COPY packages/shared/package.json ./packages/shared/
COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/tsconfig.locales.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src

# 复制 server 包配置
COPY packages/server/package.json ./packages/server/
COPY packages/server/tsconfig.json ./packages/server/
COPY packages/server/tsconfig.build.json ./packages/server/
COPY packages/server/rolldown.config.mjs ./packages/server/

# 安装 server 依赖闭包（含 devDependencies，构建时需要）；--filter 避免装入 web 等无关包
RUN bun install --frozen-lockfile --filter @miu2d/server --filter @miu2d/types --filter @miu2d/shared --filter miu2d

# 复制源代码和脚本
COPY packages/server/src ./packages/server/src
COPY packages/server/scripts ./packages/server/scripts
COPY packages/server/prisma ./packages/server/prisma

# 构建应用（prebuild 生成依赖，@miu2d/* 工作区包全部内联）
WORKDIR /app/packages/server
RUN bun run build

# 生产阶段
FROM node:24-bookworm-slim AS runner

COPY --from=oven/bun:1.3.14 /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# 复制必要的配置文件
COPY bun.lock package.json ./
COPY packages/types/package.json ./packages/types/
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/

# bun --frozen-lockfile 要求 lockfile 里全部 workspace 成员的 package.json 在场
COPY packages/converter/package.json ./packages/converter/
COPY packages/dashboard/package.json ./packages/dashboard/
COPY packages/engine/package.json ./packages/engine/
COPY packages/engine-wasm/package.json ./packages/engine-wasm/
COPY packages/game/package.json ./packages/game/
COPY packages/ui/package.json ./packages/ui/
COPY packages/viewer/package.json ./packages/viewer/
COPY packages/web/package.json ./packages/web/

# 从构建阶段复制构建产物
COPY --from=builder /app/packages/server/dist ./packages/server/dist

# 复制 prisma schema 和迁移文件
COPY --from=builder /app/packages/server/prisma ./packages/server/prisma

# 只安装 server 的生产依赖
RUN bun install --production --frozen-lockfile --ignore-scripts --filter @miu2d/server --filter @miu2d/types --filter @miu2d/shared --filter miu2d

# 设置工作目录
WORKDIR /app/packages/server

# 暴露端口
EXPOSE 4000

# 启动应用
CMD ["node", "dist/main.js"]
