# DSH Guard - 企业级临床数据守护平台

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的企业级临床试验数据安全与智能化解决方案。

## 🎯 项目定位

**DSH Guard** 是一个功能完整的企业级临床数据守护系统，专为制药和 CRO 行业设计，提供：
- 🔒 **数据出域拦截** - AI 驱动的临床数据安全控制
- 📊 **智能 Listing 生成** - 自动化临床试验数据列表生成
- 🏥 **EDC 系统集成** - 支持 Medidata、Oracle、Veeva 等主流系统
- 🎨 **企业品牌定制** - 完整的 UI 品牌化方案
- 📝 **审计与合规** - 全流程操作审计日志

## 核心特性

### 数据安全
- ✅ SAS 数据集自动拦截（.sas7bdat, .xpt）
- ✅ Excel 敏感数据脱敏
- ✅ 需求文档智能识别（豁免拦截）
- ✅ 可信代码沙箱执行
- ✅ ZIP 密码自动猜测（不泄露候选值）

### 智能识别
- ✅ 多行表头自动检测
- ✅ EDC 系统字段识别与规范化
- ✅ 临床数据模式匹配
- ✅ AI 增强的结构理解

### Listing 生成
- ✅ Medical / RBQM / Manual Review / Report 四大场景
- ✅ 规格文档自动解析（XLSX/DOCX）
- ✅ Pandas 代码生成与沙箱执行
- ✅ CONTENTS 目录页自动生成
- ✅ 复核列与公式注入防护

### 企业功能
- ✅ 完整的品牌配置系统
- ✅ OAuth2 / LDAP / SAML 认证（插件）
- ✅ 操作审计日志
- ✅ 多租户支持（规划中）

## 快速开始

### 环境要求

- **Node.js** >= 22.19.0 或 >= 24.0.0
- **pnpm** >= 11.7.0
- **Python** >= 3.9（用于数据沙箱）

### 安装

```bash
# 1. 克隆仓库
git clone <repository-url>
cd dsh-guard

# 2. 安装 Node.js 依赖
pnpm install

# 3. 安装 Python 依赖（推荐使用虚拟环境）
cd packages/enterprise/clinical-guard/python
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cd ../../../..

# 4. 构建企业插件
pnpm build
```

### 配置

1. **复制环境变量模板**：
```bash
cp .env.example .env
```

2. **编辑 `.env`**，填入你的配置：
```env
# DeepSeek API 密钥
DEEPSEEK_API_KEY=your-api-key

# OAuth2 认证（可选）
OAUTH2_CLIENT_ID=your-client-id
OAUTH2_CLIENT_SECRET=your-client-secret
OAUTH2_AUTH_URL=https://your-auth-server/oauth/authorize
OAUTH2_TOKEN_URL=https://your-auth-server/oauth/token
OAUTH2_USERINFO_URL=https://your-auth-server/oauth/userinfo

# 企业品牌配置（可选，也可在 cordis.yml 中配置）
EMERALD_BRAND_NAME=Your Company Clinical
EMERALD_BRAND_SHORT_NAME=YourCo

# 审计日志路径（可选）
EMERALD_AUDIT_ROOT=/path/to/audit/logs

# Listing 执行限额（可选，默认 50）
EMERALD_LISTING_MAX_EXECUTIONS=50
```

3. **编辑 `configs/cordis.yml`**，调整插件配置：
```yaml
plugins:
  - name: '@dsh-guard/clinical-guard'
    config:
      dataEgressControl:
        enabled: true  # 数据拦截开关
      branding:
        enabled: true
        brandName: 'Your Company Clinical'
        brandShortName: 'YourCo'
```

### 运行

```bash
# 启动 Web UI
pnpm start

# 或无界面模式（仅 API 服务）
pnpm start:headless
```

访问 `http://localhost:3080` 即可使用（端口由 `.env` 中的 `PORT` 控制）。

## 项目架构

```
dsh-guard/
├── packages/
│   └── enterprise/               # 企业插件
│       ├── auth/                 # 认证插件（OAuth2/LDAP/SAML）
│       └── clinical-guard/       # 临床数据守护插件 ⭐
│           ├── src/              # TypeScript 核心
│           │   ├── index.ts      # 插件入口（桥接层）
│           │   ├── service.ts    # 主服务
│           │   ├── config.ts     # 配置定义
│           │   └── core/         # 核心模块
│           │       ├── egress-switch.ts       # 出域拦截开关
│           │       ├── header-detector.ts     # 表头检测
│           │       ├── edc-field-detector.ts  # EDC 字段识别
│           │       └── listing-template.ts    # Listing 模板
│           ├── python/           # Python 运行时
│           │   ├── src/          # JavaScript 桥接层
│           │   │   ├── index.js           # Python 入口
│           │   │   ├── branding.js        # 品牌配置
│           │   │   ├── clinical-listing-plugin.js  # Listing 工具
│           │   │   ├── data-interception-policy.js # 拦截策略
│           │   │   └── tool-result-guard.js        # 工具结果守护
│           │   └── security/     # Python 安全模块
│           │       ├── worker.py              # Worker 主程序
│           │       ├── code_sandbox.py        # 代码沙箱
│           │       ├── listing_executor.py    # Listing 执行器
│           │       ├── archive_passwords.py   # ZIP 密码猜测
│           │       ├── header_detect.py       # 表头检测算法
│           │       └── ... (10+ 安全模块)
│           ├── tests/            # 测试套件
│           │   ├── unit/         # 单元测试
│           │   ├── integration/  # 集成测试
│           │   └── e2e/          # 端到端测试
│           └── lib/              # 编译输出
├── configs/
│   └── cordis.yml                # Cordis 插件配置
├── docs/
│   ├── reports/                  # 审计报告
│   ├── archive/                  # 历史文档
│   └── enterprise/               # 企业文档
│       ├── QUICK_START.md        # 快速开始
│       └── ... (开发文档)
├── scripts/                      # 构建脚本
├── .archive-old-architecture/    # 旧架构归档（参考）
├── package.json                  # 项目配置
├── pnpm-workspace.yaml           # pnpm workspace 配置
└── tsconfig.json                 # TypeScript 配置
```

## 核心插件说明

### @dsh-guard/clinical-guard

**临床数据守护插件** - 本项目的核心，提供完整的临床数据安全和智能化能力。

**架构设计**：
- **TypeScript 层** - 服务编排、配置管理、核心业务逻辑
- **Python 层** - 数据处理、代码沙箱、安全执行
- **桥接层** - JavaScript/Python IPC 通信

**主要组件**：

1. **数据出域拦截引擎** (`egress-switch.ts`)
   - 实时拦截 SAS 数据集、Excel 单元格
   - AI 驱动的敏感数据识别
   - 可配置的拦截策略

2. **表头检测器** (`header-detector.ts` + `header_detect.py`)
   - 多行表头合并
   - 无表头降级处理
   - XLS/XLSX/CSV 通用支持

3. **EDC 字段识别器** (`edc-field-detector.ts`)
   - Medidata Rave 字段映射
   - Oracle Clinical 字段映射
   - Veeva Vault 字段映射

4. **Listing 模板管理器** (`listing-template.ts`)
   - Medical / RBQM / Manual / Report 四大模板
   - CONTENTS 目录页生成
   - 复核列与公式防护

5. **Python 安全沙箱** (`code_sandbox.py`)
   - AST 白名单验证
   - 受限运行时（禁止文件 I/O）
   - 子进程隔离执行
   - 超时与异常处理

6. **品牌配置系统** (`branding.js`)
   - Web UI 品牌名称替换
   - 自定义 Logo 和 Favicon
   - 设置页数据拦截开关注入

### @dsh-guard/enterprise-auth

**企业认证插件** - 提供多种企业级身份认证方式（可选）。

支持：
- OAuth2 / OpenID Connect
- LDAP / Active Directory
- SAML 2.0
- 多因素认证（MFA）

## 开发指南

### 本地开发

```bash
# 安装依赖（含 Python 环境自动准备）
pnpm install

# 运行测试
pnpm test

# 运行单元测试
pnpm test:unit

# 运行集成测试
pnpm test:integration

# 测试覆盖率
pnpm test:coverage

# 类型检查
pnpm typecheck

# 构建所有插件
pnpm build

# 单独准备 Python 环境（检测模式）
node scripts/setup-python.js --check

# 清理构建产物
pnpm clean
```

### 创建新插件

```bash
# 1. 创建插件目录
mkdir -p packages/enterprise/my-plugin/src

# 2. 初始化 package.json
cd packages/enterprise/my-plugin
pnpm init

# 3. 编写插件代码（参考 auth 或 clinical-guard）
# 4. 在 configs/cordis.yml 中注册插件
```

参考现有实现：[auth 插件](packages/enterprise/auth/src/index.ts)（最小骨架）、
[clinical-guard 插件](packages/enterprise/clinical-guard/src/index.ts)（含 Python 桥接）。

### 目录结构规范

```
packages/enterprise/my-plugin/
├── src/                  # TypeScript 源码
│   ├── index.ts          # 插件入口
│   ├── service.ts        # 服务类
│   └── config.ts         # 配置定义
├── lib/                  # 编译输出（不提交）
├── tests/                # 测试文件
│   ├── unit/             # 单元测试
│   └── integration/      # 集成测试
├── package.json          # 包配置
├── tsconfig.json         # TypeScript 配置
└── README.md             # 插件文档
```

## 测试

### 测试策略

- **单元测试** - 覆盖核心逻辑（egress-switch, edc-field-detector 等）
- **集成测试** - 测试插件集成和 Python 桥接
- **E2E 测试** - 端到端场景测试

### 运行测试

```bash
# 所有测试
pnpm test

# 仅单元测试
pnpm --filter @dsh-guard/clinical-guard test:unit

# 仅集成测试
pnpm --filter @dsh-guard/clinical-guard test:integration

# E2E 测试
pnpm --filter @dsh-guard/clinical-guard test:e2e

# 测试覆盖率
pnpm test:coverage
```

## 部署

### 生产环境部署

```bash
# 1. 构建
pnpm build

# 2. 安装生产依赖
pnpm install --prod

# 3. 配置环境变量（.env）
# 4. 启动服务
NODE_ENV=production pnpm start:headless
```

注意：headless 模式下无 `webServer` 服务，品牌注入与 Listing 工具不会挂载
（插件会记录警告并降级，核心拦截策略不受影响）。需要完整功能请使用 `pnpm start`。

## 常见问题

### Q: Python worker 启动失败？
A: 检查 Python 版本（>=3.9）和依赖安装：
```bash
cd packages/enterprise/clinical-guard/python
pip install -r requirements.txt
```

### Q: 数据拦截不生效？
A: 检查 `configs/cordis.yml` 中 `dataEgressControl.enabled` 是否为 `true`。

### Q: 如何自定义品牌？
A: 在 `configs/cordis.yml` 中配置：
```yaml
branding:
  enabled: true
  brandName: 'Your Company'
  brandShortName: 'YourCo'
```

### Q: 如何查看审计日志？
A: 设置环境变量 `EMERALD_AUDIT_ROOT`，日志将写入该目录。

## 技术栈

- **运行时**: Node.js 22+ / Python 3.9+
- **框架**: DeepSeek Harness + Cordis
- **语言**: TypeScript 6.0 / Python 3.9
- **包管理**: pnpm workspace
- **测试**: Vitest (TS) / pytest (Python)
- **构建**: tsc (TypeScript Compiler)
- **数据处理**: pandas, numpy (Python)
- **安全**: AST 白名单 + 子进程隔离

## 文档

- [快速开始](docs/enterprise/QUICK_START.md)
- [架构审计报告](docs/reports/项目架构与代码全面审计报告.md)
- [E2E 测试指南](docs/E2E_TEST_GUIDE.md)
- [历史文档归档](docs/archive/)

## 贡献

欢迎提交 Issue 和 Pull Request！

### 贡献流程

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

## 许可证

MIT License

---

**维护团队**: DSH Guard Team
**基于**: DeepSeek Harness
**最后更新**: 2026-08-25
