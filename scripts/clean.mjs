import fs from 'node:fs'
import path from 'node:path'

for (const relative of ['node_modules', '.pnpm-store', 'coverage', 'profiles/enterprise/node_modules', 'packages/enterprise/auth/lib', 'packages/enterprise/tool-audit/lib', 'packages/enterprise/ui-settings/lib', 'packages/enterprise/auth/tsconfig.tsbuildinfo', 'packages/enterprise/tool-audit/tsconfig.tsbuildinfo', 'packages/enterprise/ui-settings/tsconfig.tsbuildinfo']) {
  const target = path.join(process.cwd(), relative)
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true })
}
console.log('enterprise generated state cleaned')
