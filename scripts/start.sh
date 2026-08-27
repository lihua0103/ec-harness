#!/usr/bin/env sh
# start.bat 的类 Unix 对应物。两者都只是 scripts/start.mjs 的薄包装，
# 真正的编排逻辑只有一份，避免两个平台的启动行为漂移。
set -eu
cd "$(dirname "$0")"

echo "[DSH] 正在启动 DeepSeek Harness WebUI..."

if ! command -v node >/dev/null 2>&1; then
  echo "[DSH] 未找到 Node.js，请安装 Node 22.19+ 或 24+" >&2
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "[DSH] 未找到 pnpm，请先安装 pnpm 11" >&2
  exit 1
fi

# 不加 exec：留住本进程才能在失败时打印退出码（与 start.bat 的行为对齐）。
if node scripts/start.mjs; then
  exit 0
else
  code=$?
  echo "[DSH] 启动失败，退出码 ${code}" >&2
  exit "${code}"
fi
