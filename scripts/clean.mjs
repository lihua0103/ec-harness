import fs from 'node:fs'
import path from 'node:path'
import { listEnterprisePlugins } from './enterprise-plugins.mjs'

const root = process.cwd()

const targets = ['node_modules', '.pnpm-store', 'coverage', 'profiles/enterprise/node_modules']
  .map((relative) => path.join(root, relative))

// 插件产物按目录遍历收集，新增插件无需改本文件。lib 与 tsbuildinfo **必须成对删除**：
// 只删 lib 会让 tsc -b 认为项目仍是最新的（它只比对 tsbuildinfo 与源文件时间戳），
// 于是下次构建零产出且退出码 0，故障推迟到 boot 期才以 ERR_MODULE_NOT_FOUND 暴露。
for (const plugin of listEnterprisePlugins(root)) {
  targets.push(path.join(plugin.dir, 'lib'), plugin.buildInfo)
}

for (const target of targets) {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true })
}
console.log('enterprise generated state cleaned')
