import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

// 1. 检查 .env
const envPath = path.join(root, '.env')
if (!fs.existsSync(envPath)) {
  fs.copyFileSync(path.join(root, '.env.example'), envPath)
  console.log('[init] 已创建 .env，请编辑并填写 DEEPSEEK_API_KEY')
} else {
  console.log('[init] .env 已存在')
}

// 2. 检查 pnpm
console.log('[init] 请运行：pnpm install')
console.log('[init] 然后运行：pnpm start')
