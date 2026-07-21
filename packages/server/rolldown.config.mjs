import { fileURLToPath } from "node:url";
import typescript from "@rollup/plugin-typescript";

const workspace = (rel) => fileURLToPath(new URL(rel, import.meta.url));

/** @type {import('rolldown').RolldownOptions} */
export default {
  input: {
    main: "src/main.ts",
    "db/migrate": "src/db/migrate.ts",
    "db/rehash-passwords": "src/db/rehash-passwords.ts",
  },
  output: {
    format: "es",
    dir: "dist",
    entryFileNames: "[name].js",
    chunkFileNames: "chunks/[name]-[hash].js",
    sourcemap: true,
  },
  // npm 包和 node: 内置标记为外部；@miu2d/* 工作区包由 rolldown 直接打包
  external: (id) =>
    id.startsWith("node:") ||
    (!id.startsWith(".") &&
      !id.startsWith("/") &&
      !id.startsWith("@/") &&
      !id.startsWith("@miu2d/")),
  // 显式 alias 取代 @rollup/plugin-node-resolve：后者在 rolldown 的并行解析下会竞态，
  // 同一个 @miu2d/types 一半内联、一半漏成 external，双架构构建里 amd64 那份就这么
  // 带着裸 import 上了线（runner 阶段没有 packages/*/dist，node 起不来）
  resolve: {
    alias: {
      "@miu2d/types": workspace("../types/dist/index.js"),
      "@miu2d/shared/locales": workspace("../shared/dist/locales/index.js"),
    },
  },
  // an unresolved @miu2d import once shipped silently as external and crashed prod — fail loudly
  onwarn(warning, warn) {
    if (warning.code === "UNRESOLVED_IMPORT") throw new Error(warning.message);
    warn(warning);
  },
  // JSON is handled natively by rolldown — @rollup/plugin-json no longer needed
  plugins: [
    // Keep @rollup/plugin-typescript for emitDecoratorMetadata support (not yet in Oxc)
    typescript({
      tsconfig: "./tsconfig.build.json",
      compilerOptions: {
        module: "ESNext",
      },
    }),
  ],
};
