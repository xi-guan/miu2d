# 构建阶段: 只为 prisma generate (需要 devDependencies 里的 prisma CLI)
# 运行时是 bun, 直接跑 TS 源码, 无打包步骤
FROM oven/bun:1.3.14 AS builder

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
COPY packages/types/package.json ./packages/types/
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/ui/package.json ./packages/ui/
COPY packages/viewer/package.json ./packages/viewer/
COPY packages/web/package.json ./packages/web/

# 安装 server 依赖闭包（含 devDependencies, prisma generate 需要）
RUN bun install --frozen-lockfile --filter @miu2d/server --filter @miu2d/types --filter @miu2d/shared --filter miu2d

# 复制 prisma schema 并生成 client（输出到 src/db/generated, 未入库）
COPY packages/server/prisma ./packages/server/prisma
COPY packages/server/prisma.config.ts ./packages/server/
COPY packages/server/src ./packages/server/src
RUN bun run --cwd packages/server db:generate

# 生产阶段
FROM oven/bun:1.3.14 AS runner

WORKDIR /app

# 复制 workspace 配置文件（同 builder, frozen-lockfile 需要全量 manifests）
COPY bun.lock package.json ./
COPY tsconfig.base.json ./
COPY packages/converter/package.json ./packages/converter/
COPY packages/dashboard/package.json ./packages/dashboard/
COPY packages/engine/package.json ./packages/engine/
COPY packages/engine-wasm/package.json ./packages/engine-wasm/
COPY packages/game/package.json ./packages/game/
COPY packages/types/package.json ./packages/types/
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/ui/package.json ./packages/ui/
COPY packages/viewer/package.json ./packages/viewer/
COPY packages/web/package.json ./packages/web/

# 只安装 server 的生产依赖
RUN bun install --production --frozen-lockfile --ignore-scripts --filter @miu2d/server --filter @miu2d/types --filter @miu2d/shared --filter miu2d

# 运行所需源码: server src(含生成的 prisma client) + tsconfig(bun 读 paths 解析 workspace 包)
COPY --from=builder /app/packages/server/src ./packages/server/src
COPY packages/server/tsconfig.json ./packages/server/
COPY packages/types/src ./packages/types/src
COPY packages/shared/src ./packages/shared/src

# prisma schema + 迁移（容器内跑 db:migrate 时用）
COPY packages/server/prisma ./packages/server/prisma
COPY packages/server/prisma.config.ts ./packages/server/

# 设置工作目录
WORKDIR /app/packages/server

# 暴露端口
EXPOSE 4000

# 启动应用（bun 直跑 TS）
CMD ["bun", "src/main.ts"]
