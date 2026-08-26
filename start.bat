@echo off
setlocal

if not exist .env (
  echo [DSH Guard] 请先复制 .env.example 为 .env 并填写 DEEPSEEK_API_KEY
  exit /b 1
)

echo [DSH Guard] 启动 DeepSeek Harness Web UI...
pnpm start
