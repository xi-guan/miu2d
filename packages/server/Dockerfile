# 构建阶段
FROM node:24-bookworm-slim AS builder

# 启用 corepack 以使用 pnpm
RUN corepack enable && corepack prepare pnpm@10.16.1 --activate

WORKDIR /app

# 复制 workspace 配置文件
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY tsconfig.base.json ./

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

# 安装所有依赖（包括 devDependencies，构建时需要）
RUN pnpm install --frozen-lockfile

# 复制源代码和脚本
COPY packages/server/src ./packages/server/src
COPY packages/server/scripts ./packages/server/scripts
COPY packages/server/prisma ./packages/server/prisma

# 构建应用（prebuild 生成依赖，@miu2d/* 工作区包全部内联）
WORKDIR /app/packages/server
RUN pnpm build

# 生产阶段
FROM node:24-bookworm-slim AS runner

# 启用 corepack
RUN corepack enable && corepack prepare pnpm@10.16.1 --activate

WORKDIR /app

# 复制必要的配置文件
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/types/package.json ./packages/types/
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/

# 从构建阶段复制构建产物
COPY --from=builder /app/packages/server/dist ./packages/server/dist

# 复制 prisma schema 和迁移文件
COPY --from=builder /app/packages/server/prisma ./packages/server/prisma

# 只安装生产依赖
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

# 设置工作目录
WORKDIR /app/packages/server

# 暴露端口
EXPOSE 4000

# 启动应用
CMD ["node", "dist/main.js"]
