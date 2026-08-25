# DSH Guard 快速开始指南

## 1. 环境准备

### Node.js

需要 Node.js 22.19.0+ 或 24.0.0+：

```bash
node --version
```

### pnpm

```bash
# 使用 Corepack（推荐）
corepack enable
corepack prepare pnpm@11.7.0 --activate

# 或直接安装
npm install -g pnpm
```

验证：`pnpm --version` 应 >= 11.7.0

### Python

clinical-guard 插件的数据沙箱依赖 Python 3.9+（用于 SAS/Excel 读取与 pandas 变换）：

```bash
python3 --version
```

没有 Python 也能启动，但数据沙箱、Listing 生成与表头检测将不可用。

## 2. 克隆项目

```bash
git clone https://github.com/your-org/dsh-guard.git
cd dsh-guard
```

## 3. 安装依赖

```bash
pnpm install
```

`pnpm install` 会自动执行 `scripts/setup-python.js`，在
`packages/enterprise/clinical-guard/python/.venv` 创建虚拟环境并安装
Python 依赖（pandas、pyreadstat、openpyxl、pyzipper 等）。

Python 缺失或安装失败**不会中断** Node 依赖安装，只会打印警告。
之后可单独重试：

```bash
# 仅检测环境
node scripts/setup-python.js --check

# 创建虚拟环境并安装依赖
node scripts/setup-python.js
```

## 4. 配置环境变量

```bash
cp .env.example .env
```

最少需要配置 API Key：

```env
DEEPSEEK_API_KEY=sk-your-actual-api-key-here
```

`.env.example` 中列出了所有可用变量（品牌、数据拦截开关、安全平面、
审计与限额、超时等），均带默认值说明。生产环境务必设置：

```env
EMERALD_HASH_SALT=<随机值>
EMERALD_SIGNING_SALT=<随机值>
```

## 5. 编辑插件配置

`configs/cordis.yml` 控制插件的启用与参数。clinical-guard 默认启用：

```yaml
plugins:
  - name: '@dsh-guard/clinical-guard'
    config:
      dataEgressControl:
        enabled: true          # 数据拦截主开关
      branding:
        enabled: true
        brandName: 'Emerald Clinical'
        brandShortName: 'Emerald'
```

企业认证插件默认禁用，需要时改 `disabled`：

```yaml
  - name: '@dsh-guard/enterprise-auth'
    disabled: false
    config:
      provider: oauth2
```

## 6. 构建

```bash
pnpm build
```

构建产物在各插件的 `lib/` 目录。类型检查可单独运行：

```bash
pnpm typecheck
```

## 7. 运行

```bash
# 完整 Web UI（推荐）
pnpm start

# 无界面模式
pnpm start:headless
```

默认访问 `http://127.0.0.1:3080`（端口由 `.env` 的 `PORT` 控制）。

**关于 headless 模式**：Python 层需要宿主提供 `webServer` 和 `tools`
两个服务。headless 下这两者不可用，插件会打印警告并跳过 Python 运行时挂载
（品牌注入、Listing 工具、数据沙箱不可用），TypeScript 核心拦截策略不受影响。

## 8. 开发你的第一个插件

### 创建目录

```bash
mkdir -p packages/enterprise/my-plugin/src
cd packages/enterprise/my-plugin
pnpm init
```

### package.json

```json
{
  "name": "@dsh-guard/enterprise-my-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "scripts": {
    "build": "tsc"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@types/node": "^22.20.0",
    "typescript": "^6.0.0"
  }
}
```

### tsconfig.json

必须显式设置 `noEmit: false`——根配置为类型检查用途设了 `noEmit: true`，
子包若不覆盖会静默产出空的 `lib/`：

```json
{
  "extends": "../../../tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "declaration": true,
    "outDir": "lib",
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "lib", "tests"]
}
```

### src/index.ts

注意 cordis v4 的两个约束：

1. **不导出 `Schema`** —— Schema 由独立的 `@deepseek-ai/schemastery` 提供，
   本项目未安装。用 TypeScript 接口加默认值常量表达配置契约。
2. **`Service` 构造签名是 `(ctx, name)`** —— 只接受两个参数。

```typescript
import { Context, Service } from '@deepseek-ai/cordis'

export interface Config {
  enabled: boolean
  message: string
}

export const DEFAULT_CONFIG: Config = {
  enabled: true,
  message: 'Hello from my plugin!',
}

export class MyPluginService extends Service {
  public config: Config

  constructor(ctx: Context, config: Partial<Config> = {}) {
    super(ctx, 'myPlugin')
    this.config = { ...DEFAULT_CONFIG, ...config }
    if (!this.config.enabled) return
    ctx.logger.info(this.config.message)
  }
}

export const name = '@dsh-guard/enterprise-my-plugin'
export const Config = DEFAULT_CONFIG

export function apply(ctx: Context, config: Partial<Config> = {}) {
  ctx.plugin(MyPluginService, config)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    myPlugin: MyPluginService
  }
}
```

### 注册插件

编辑 `configs/cordis.yml`：

```yaml
plugins:
  - name: '@dsh-guard/enterprise-my-plugin'
    config:
      enabled: true
      message: '我的第一个插件!'
```

### 构建并运行

```bash
cd ../../..
pnpm build
pnpm start
```

参考现有实现：[auth 插件](../../packages/enterprise/auth/src/index.ts)（最小骨架）、
[clinical-guard 插件](../../packages/enterprise/clinical-guard/src/index.ts)（含 Python 桥接）。

## 9. 常见问题

### Q: 找不到 dsh 命令？

`@deepseek-ai/dsh` 是根依赖，`pnpm install` 后应可用。全局安装：

```bash
pnpm add -g @deepseek-ai/dsh
```

### Q: 依赖安装失败？

切换镜像：

```bash
pnpm config set registry https://registry.npmmirror.com
pnpm install
```

### Q: 插件没有加载？

依次检查：`cordis.yml` 中未设 `disabled: true`、已执行 `pnpm build`、
插件 `lib/` 目录有产出、启动日志中是否有错误。

### Q: 构建后 lib/ 是空的？

子包 tsconfig 缺少 `"noEmit": false`。根配置的 `noEmit: true` 会被继承，
导致 tsc 静默不产出文件。

### Q: 提示 `Module '@deepseek-ai/cordis' has no exported member 'Schema'`？

cordis v4 不再导出 Schema。见第 8 节的配置写法。

### Q: Python worker 启动失败？

检查虚拟环境与依赖：

```bash
node scripts/setup-python.js --check
cd packages/enterprise/clinical-guard/python
.venv/bin/python -c "import security.worker"
```

### Q: 数据拦截不生效？

确认 `configs/cordis.yml` 中 `dataEgressControl.enabled` 为 `true`，
且未通过环境变量 `DATA_INTERCEPTION_ENABLED=0` 关闭。
也可在 Web UI 的「设置 → 通用设置 → 临床数据出域拦截」中查看当前状态。

## 10. 下一步

- [项目总览与架构](../../README.md)
- [E2E 测试指南](../E2E_TEST_GUIDE.md)
- [架构审计报告](../reports/项目架构与代码全面审计报告.md)

## 获取帮助

- 文档目录：`docs/`
- 提交 Issue：GitHub Issues
- 内部支持：联系技术团队
