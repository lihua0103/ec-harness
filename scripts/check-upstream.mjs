import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const upstreamPkg = path.join(root, 'upstream', 'deepseek-harness', 'package.json')
if (!fs.existsSync(upstreamPkg)) {
  console.error('缺少 upstream/deepseek-harness，请执行 git submodule update --init --depth 1')
  process.exit(1)
}
const pkg = JSON.parse(fs.readFileSync(upstreamPkg, 'utf8'))
const required = ['packageManager', 'workspaces', 'scripts']
for (const key of required) if (pkg[key] === undefined) throw new Error(`官方基线缺少字段：${key}`)
console.log(`upstream contract ok: ${pkg.name}@${pkg.version}`)
