#!/usr/bin/env node
/**
 * DSH Guard 初始化脚本
 * 用于快速设置开发环境
 */

import { execSync } from 'child_process'
import { existsSync, copyFileSync } from 'fs'
import { join } from 'path'

console.log('🚀 DSH Guard 初始化开始...\n')

// 1. 检查 Node.js 版本
console.log('📋 检查 Node.js 版本...')
const nodeVersion = process.version
const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0])
if (majorVersion < 22) {
  console.error(`❌ Node.js 版本过低: ${nodeVersion}`)
  console.error('   需要: >= 22.19.0')
  process.exit(1)
}
console.log(`✅ Node.js 版本: ${nodeVersion}\n`)

// 2. 检查 pnpm
console.log('📋 检查 pnpm...')
try {
  const pnpmVersion = execSync('pnpm --version', { encoding: 'utf8' }).trim()
  console.log(`✅ pnpm 版本: ${pnpmVersion}\n`)
} catch (error) {
  console.error('❌ 未找到 pnpm')
  console.error('   安装: npm install -g pnpm')
  process.exit(1)
}

// 3. 复制环境变量文件
console.log('📋 设置环境变量...')
const envExample = join(process.cwd(), '.env.example')
const envFile = join(process.cwd(), '.env')
if (!existsSync(envFile)) {
  if (existsSync(envExample)) {
    copyFileSync(envExample, envFile)
    console.log('✅ 已创建 .env 文件\n')
  } else {
    console.log('⚠️  未找到 .env.example，跳过\n')
  }
} else {
  console.log('✅ .env 文件已存在\n')
}

// 4. 安装依赖
console.log('📦 安装依赖...')
try {
  execSync('pnpm install', { stdio: 'inherit' })
  console.log('✅ 依赖安装完成\n')
} catch (error) {
  console.error('❌ 依赖安装失败')
  process.exit(1)
}

// 5. 构建企业插件
console.log('🔨 构建企业插件...')
try {
  execSync('pnpm build', { stdio: 'inherit' })
  console.log('✅ 构建完成\n')
} catch (error) {
  console.log('⚠️  构建失败（可能还没有插件代码）\n')
}

// 完成
console.log('🎉 DSH Guard 初始化完成！\n')
console.log('下一步：')
console.log('  1. 编辑 .env 文件，填入你的 API Key')
console.log('  2. 运行 pnpm start 启动服务')
console.log('  3. 访问 http://127.0.0.1:3080\n')
console.log('文档：')
console.log('  - 快速开始: docs/enterprise/QUICK_START.md')
console.log('  - 插件开发: docs/enterprise/PLUGIN_GUIDE.md\n')
