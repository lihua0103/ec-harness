import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

/**
 * 构建企业插件：遍历 packages/enterprise/* 执行 tsc。
 */
const root = process.cwd()
const enterpriseDir = path.join(root, 'packages', 'enterprise')

if (!fs.existsSync(enterpriseDir)) {
  console.log('no enterprise plugins to build')
  process.exit(0)
}

for (const name of fs.readdirSync(enterpriseDir)) {
  const pkgDir = path.join(enterpriseDir, name)
  const pkgJson = path.join(pkgDir, 'package.json')
  if (!fs.existsSync(pkgJson)) continue
  const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'))
  if (!pkg.scripts?.build) continue
  console.log(`building ${pkg.name}...`)
  execSync('pnpm run build', { cwd: pkgDir, stdio: 'inherit' })
}
