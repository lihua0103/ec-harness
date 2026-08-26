import fs from 'node:fs'
import path from 'node:path'

/**
 * 遍历 packages/enterprise/* 得到企业插件清单。
 *
 * 这是"哪些是企业插件"的唯一来源。**不要**在别处硬编码包名——ADR-0001 第 7 条的
 * 目标是新增插件只改一个目录加一行 bundles；一旦脚本里写死名字，漏改的那个脚本
 * 就会静默跳过新插件（start.mjs 漏了会让产物缺失推迟到 boot 期才报
 * ERR_MODULE_NOT_FOUND，clean.mjs 漏了会留下陈旧 tsbuildinfo）。
 *
 * check-architecture.mjs 另有一份面向校验的遍历（要对缺失 package.json 报错并
 * 收集 manifest），此处只回答"有哪些插件"。
 *
 * @param {string} root 仓库根
 * @returns {{ dir: string, name: string, libEntry: string, buildInfo: string }[]}
 */
export function listEnterprisePlugins(root) {
  const enterpriseDir = path.join(root, 'packages', 'enterprise')
  if (!fs.existsSync(enterpriseDir)) return []
  return fs.readdirSync(enterpriseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(enterpriseDir, entry.name))
    // 只认有 package.json 的目录，避免把 .turbo/ 之类的杂物当成插件。
    .filter((dir) => fs.existsSync(path.join(dir, 'package.json')))
    .map((dir) => ({
      dir,
      name: path.basename(dir),
      // tsconfig 的 outDir 是 lib、rootDir 是 src，故入口固定为 lib/index.js。
      libEntry: path.join(dir, 'lib', 'index.js'),
      buildInfo: path.join(dir, 'tsconfig.tsbuildinfo'),
    }))
}
