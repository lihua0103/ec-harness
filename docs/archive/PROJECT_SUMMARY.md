# DSH Guard 项目摘要

## 项目信息

- **项目名称**: DSH Guard
- **版本**: 0.1.0
- **创建日期**: 2026-08-25
- **开发模式**: 精简版（npm 依赖模式）
- **技术栈**: Node.js + TypeScript + pnpm + Cordis

## 项目目标

基于 DeepSeek Harness 进行企业级扩展，提供：
- 企业认证（LDAP/OAuth2/SAML）
- 安全审计
- 合规检查
- 监控告警

## 核心优势

### 与完整克隆对比

| 指标 | 完整克隆 | 精简版 DSH Guard |
|------|---------|------------------|
| 文件数量 | 7000+ | < 100 |
| 安装时间 | 30-60 分钟 | 2-5 分钟 |
| 磁盘占用 | 2-3 GB | < 200 MB |
| 上游更新 | 复杂（Git 合并） | 简单（npm update） |
| 维护成本 | 高 | 低 |

### 技术优势

1. **轻量化**：只依赖核心框架包
2. **模块化**：企业功能作为独立插件
3. **可维护**：清晰的目录结构
4. **可扩展**：遵循 Cordis 插件规范

## 目录结构

```
dsh-guard/
├── .git/                    # Git 仓库
├── configs/                 # 配置文件
│   └── cordis.yml          # Cordis 配置
├── docs/                    # 文档
│   └── enterprise/         # 企业文档
│       ├── QUICK_START.md
│       ├── PLUGIN_GUIDE.md
│       ├── DEVELOPMENT_STANDARDS.md
│       └── SIMPLIFIED_APPROACH.md
├── packages/                # 企业插件
│   └── enterprise/
│       └── auth/           # 认证插件
│           ├── src/
│           ├── tests/
│           ├── package.json
│           ├── tsconfig.json
│           └── README.md
├── scripts/                 # 脚本
│   └── init.mjs            # 初始化脚本
├── .env.example            # 环境变量模板
├── .gitignore              # Git 忽略文件
├── package.json            # 项目配置
├── pnpm-workspace.yaml     # pnpm workspace
├── README.md               # 项目说明
└── tsconfig.json           # TypeScript 配置
```

## 当前状态

### 已完成

- ✅ 项目结构搭建
- ✅ 基础配置文件
- ✅ 企业插件框架（auth 示例）
- ✅ 完整文档体系
- ✅ 初始化脚本

### 待完成

- ⏳ 安装依赖（需要执行 `pnpm install`）
- ⏳ 实现认证插件具体逻辑
- ⏳ 添加审计插件
- ⏳ 添加合规插件
- ⏳ 添加监控插件

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置环境

```bash
cp .env.example .env
# 编辑 .env 文件
```

### 3. 构建

```bash
pnpm build
```

### 4. 运行

```bash
# 需要先安装官方 CLI
pnpm add -g @deepseek-ai/dsh

# 启动
pnpm start
```

## 核心依赖

```json
{
  "dependencies": {
    "@deepseek-ai/cordis": "^3.20.0",
    "@deepseek-ai/schemastery": "^16.0.0"
  }
}
```

## 插件开发

所有企业插件遵循统一模板：

```typescript
import { Context, Schema, Service } from '@deepseek-ai/cordis'

export interface Config {
  enabled: boolean
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true),
})

export class MyService extends Service {
  constructor(ctx: Context, config: Config) {
    super(ctx, 'myService', true)
  }
}

export const name = '@dsh-guard/my-plugin'
export function apply(ctx: Context, config: Config) {
  ctx.plugin(MyService, config)
}
```

## 文档索引

1. [README.md](../README.md) - 项目总览
2. [QUICK_START.md](docs/enterprise/QUICK_START.md) - 快速开始
3. [PLUGIN_GUIDE.md](docs/enterprise/PLUGIN_GUIDE.md) - 插件开发指南
4. [DEVELOPMENT_STANDARDS.md](docs/enterprise/DEVELOPMENT_STANDARDS.md) - 开发规范
5. [SIMPLIFIED_APPROACH.md](docs/enterprise/SIMPLIFIED_APPROACH.md) - 精简方案说明

## 下一步计划

1. **立即执行**：
   - 运行 `pnpm install` 安装依赖
   - 配置 `.env` 文件
   - 测试基础功能

2. **短期目标**（1-2 周）：
   - 完成认证插件核心功能
   - 实现 OAuth2 认证
   - 添加单元测试

3. **中期目标**（1 个月）：
   - 添加审计插件
   - 添加合规插件
   - 完善文档

4. **长期目标**（3 个月）：
   - 监控告警系统
   - 性能优化
   - 生产环境部署

## 团队协作

### 开发流程

1. 从 `main` 分支创建功能分支
2. 开发并测试
3. 提交 Pull Request
4. Code Review
5. 合并到 `main`

### 提交规范

```
<type>(<scope>): <subject>

feat(auth): 添加 LDAP 认证支持
fix(audit): 修复日志记录问题
docs(readme): 更新安装说明
```

## 联系方式

- **技术支持**: [待补充]
- **Issue 跟踪**: GitHub Issues
- **文档中心**: docs/enterprise/

---

**项目状态**: 🟢 正常  
**最后更新**: 2026-08-25  
**维护团队**: DSH Guard Team
