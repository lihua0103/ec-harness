# DSH Guard 快速开始指南

## 1. 环境准备

### 安装 Node.js

确保安装了 Node.js 22.19.0 或更高版本：

```bash
node --version  # 应该 >= 22.19.0
```

### 安装 pnpm

```bash
# Windows
npm install -g pnpm

# 或使用 Corepack（推荐）
corepack enable
corepack prepare pnpm@11.7.0 --activate
```

验证安装：

```bash
pnpm --version  # 应该 >= 11.7.0
```

## 2. 克隆项目

```bash
git clone https://github.com/your-org/dsh-guard.git
cd dsh-guard
```

## 3. 安装依赖

```bash
pnpm install
```

安装时间：约 2-5 分钟（比完整版快 10 倍）

## 4. 配置环境

### 复制环境变量模板

```bash
cp .env.example .env
```

### 编辑 .env 文件

最少需要配置 DeepSeek API Key：

```env
DEEPSEEK_API_KEY=sk-your-actual-api-key-here
```

可选配置：

```env
# 自定义基础 URL
DEEPSEEK_BASE_URL=https://api.deepseek.com

# OAuth2 认证
OAUTH2_CLIENT_ID=your-client-id
OAUTH2_CLIENT_SECRET=your-client-secret
```

## 5. 编辑配置文件

编辑 `configs/cordis.yml`，启用需要的插件：

```yaml
plugins:
  # 启用企业认证插件
  - name: '@dsh-guard/enterprise-auth'
    disabled: false  # 改为 false 启用
    config:
      enabled: true
      provider: oauth2
```

## 6. 构建企业插件

```bash
pnpm build
```

## 7. 运行

### 方式一：直接使用官方 CLI（推荐测试）

如果你只想测试，可以直接使用官方包：

```bash
# 安装官方 CLI
pnpm add -g @deepseek-ai/dsh

# 运行
dsh web
```

### 方式二：开发模式（企业插件开发）

```bash
# 在项目目录运行
pnpm start
```

默认访问：`http://127.0.0.1:3080`

## 8. 开发你的第一个插件

### 创建插件目录

```bash
mkdir -p packages/enterprise/my-plugin/src
cd packages/enterprise/my-plugin
```

### 初始化 package.json

```bash
pnpm init
```

编辑 `package.json`：

```json
{
  "name": "@dsh-guard/enterprise-my-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "peerDependencies": {
    "@deepseek-ai/cordis": "^3.20.0",
    "@deepseek-ai/schemastery": "^16.0.0"
  }
}
```

### 编写插件代码

创建 `src/index.ts`：

```typescript
import { Context, Schema, Service } from '@deepseek-ai/cordis'

export interface Config {
  enabled: boolean
  message: string
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true),
  message: Schema.string().default('Hello from my plugin!'),
})

export class MyPluginService extends Service {
  constructor(ctx: Context, public config: Config) {
    super(ctx, 'myPlugin', true)
    ctx.logger.info(config.message)
  }
}

export const name = '@dsh-guard/enterprise-my-plugin'

export function apply(ctx: Context, config: Config) {
  ctx.plugin(MyPluginService, config)
}
```

### 添加到 Cordis 配置

编辑 `configs/cordis.yml`：

```yaml
plugins:
  - name: '@dsh-guard/enterprise-my-plugin'
    config:
      enabled: true
      message: '我的第一个插件!'
```

### 构建并测试

```bash
# 返回项目根目录
cd ../../..

# 构建插件
pnpm build

# 运行
pnpm start
```

## 9. 常见问题

### Q: 提示找不到 dsh 命令？

A: 需要先安装官方 CLI：

```bash
pnpm add -g @deepseek-ai/dsh
```

或者使用 npx：

```bash
npx @deepseek-ai/dsh web
```

### Q: 依赖安装失败？

A: 检查网络，使用国内镜像：

```bash
pnpm config set registry https://registry.npmmirror.com
pnpm install
```

### Q: 插件没有加载？

A: 检查以下几点：
1. `cordis.yml` 中 `disabled: false`
2. 插件已经构建（`pnpm build`）
3. 查看日志输出是否有错误

### Q: TypeScript 类型错误？

A: 确保安装了类型依赖：

```bash
pnpm add -D @types/node typescript
```

## 10. 下一步

- 阅读 [插件开发指南](PLUGIN_GUIDE.md)
- 查看 [企业开发规范](DEVELOPMENT_STANDARDS.md)
- 参考 [精简方案说明](SIMPLIFIED_APPROACH.md)

## 获取帮助

- 查看文档：`docs/enterprise/`
- 提交 Issue：GitHub Issues
- 内部支持：联系技术团队

---

祝你开发愉快！🚀
