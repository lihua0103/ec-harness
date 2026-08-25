# DSH Guard - 企业级 AI Agent 框架

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的轻量级企业扩展。

## 项目特点

- 🚀 **轻量精简**：只依赖核心框架，不包含冗余代码
- 🔌 **插件化**：基于 Cordis 框架，一切功能都是插件
- 🏢 **企业级**：内置企业认证、审计、合规等功能
- 📦 **pnpm 管理**：使用 pnpm workspace 统一管理
- ⚡ **快速启动**：安装依赖只需几分钟

## 快速开始

### 环境要求

- Node.js >= 22.19.0 或 >= 24.0.0
- pnpm >= 11.7.0

### 安装

```bash
# 安装依赖
pnpm install

# 构建企业插件
pnpm build
```

### 配置

1. 复制环境变量模板：
```bash
cp .env.example .env
```

2. 编辑 `.env`，填入你的配置：
```env
DEEPSEEK_API_KEY=your-api-key
OAUTH2_CLIENT_ID=your-client-id
OAUTH2_CLIENT_SECRET=your-client-secret
```

3. 编辑 `configs/cordis.yml`，启用需要的插件

### 运行

```bash
# 启动 Web UI（需要先安装 @deepseek-ai/dsh）
pnpm start

# 或无界面模式
pnpm start:headless
```

## 项目结构

```
dsh-guard/
├── packages/
│   └── enterprise/          # 企业插件目录
│       ├── auth/            # 认证插件
│       ├── audit/           # 审计插件（待开发）
│       └── compliance/      # 合规插件（待开发）
├── configs/
│   └── cordis.yml           # Cordis 配置文件
├── docs/
│   └── enterprise/          # 企业文档
├── scripts/                 # 构建脚本
├── package.json             # 项目配置
└── pnpm-workspace.yaml      # pnpm workspace 配置
```

## 企业插件

### 已实现

- ✅ [@dsh-guard/enterprise-auth](packages/enterprise/auth/README.md) - 企业认证插件（基础框架）

### 规划中

- 🔄 `@dsh-guard/enterprise-audit` - 安全审计插件
- 🔄 `@dsh-guard/enterprise-compliance` - 合规检查插件
- 🔄 `@dsh-guard/enterprise-monitoring` - 监控告警插件

## 开发指南

### 创建新插件

```bash
# 创建插件目录
mkdir -p packages/enterprise/my-plugin/src

# 创建 package.json
cd packages/enterprise/my-plugin
pnpm init

# 编写代码
# 参考 packages/enterprise/auth 的结构
```

详见 [docs/enterprise/PLUGIN_GUIDE.md](docs/enterprise/PLUGIN_GUIDE.md)

### 常用命令

```bash
# 安装依赖
pnpm install

# 构建所有插件
pnpm build

# 运行测试
pnpm test

# 类型检查
pnpm typecheck

# 代码检查
pnpm lint

# 清理构建产物
pnpm clean
```

## 为什么选择精简版？

相比完整克隆 DeepSeek Harness：

| 对比项 | 完整克隆 | 精简版（当前） |
|--------|---------|---------------|
| 文件数量 | 7000+ | < 100 |
| 安装时间 | 30-60 分钟 | 2-5 分钟 |
| 磁盘占用 | 2-3 GB | < 200 MB |
| 维护成本 | 高（需要同步上游） | 低（npm 更新） |
| 专注度 | 分散 | 集中（只写企业逻辑） |

## 依赖管理

核心依赖通过 npm 包引入：

```json
{
  "dependencies": {
    "@deepseek-ai/cordis": "^3.20.0",
    "@deepseek-ai/schemastery": "^16.0.0"
  }
}
```

需要更多功能时，按需添加：

```bash
# 添加 DSH 核心包（如果需要完整功能）
pnpm add @deepseek-ai/dsh

# 添加特定功能
pnpm add @deepseek-ai/dsh-tools
pnpm add @deepseek-ai/dsh-llm
```

## 文档

- [企业开发规范](docs/enterprise/DEVELOPMENT_STANDARDS.md)
- [插件开发指南](docs/enterprise/PLUGIN_GUIDE.md)
- [精简方案说明](docs/enterprise/SIMPLIFIED_APPROACH.md)

## 贡献

欢迎提交 Issue 和 Pull Request！

## 许可证

MIT License

---

**由 DSH Guard 团队维护**  
基于 DeepSeek Harness  
最后更新：2026-08-25
