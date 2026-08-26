# DSH Guard

DeepSeek Harness 企业二次开发纯净骨架。

> 基于官方 `@deepseek-ai/dsh` 运行时，通过 pnpm 管理，只保留核心运转配置、企业插件目录与开发文档。

---

## 环境要求

- **Node.js**: `^22.19.0 || >=24.0.0`
- **包管理器**: pnpm `>=11.7.0`

---

## 快速开始

```sh
# 1. 安装依赖（会拉取 @deepseek-ai/dsh 运行时）
pnpm install

# 2. 复制环境变量模板并填写 API Key
cp .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY

# 3. 启动 Web UI
pnpm start
# 或 Windows 双击 start.bat
```

浏览器打开：[http://127.0.0.1:3080](http://127.0.0.1:3080)

---

## 项目结构

```
dsh-guard/
├── configs/
│   └── cordis.yml          # Cordis profile 配置
├── packages/enterprise/
│   └── auth/               # 企业认证插件示例
├── scripts/
│   ├── init.mjs            # 初始化脚本
│   └── build-enterprise.ts # 企业插件构建脚本
├── docs/enterprise/
│   ├── QUICK_START.md
│   └── PLUGIN_GUIDE.md
├── package.json            # pnpm 项目配置
├── pnpm-workspace.yaml     # workspace 配置
├── start.bat               # Windows 启动脚本
├── .env.example            # 环境变量模板
└── README.md               # 本文件
```

---

## 企业插件开发

1. 在 `packages/enterprise/` 下新建插件目录。
2. 参考 `packages/enterprise/auth/` 编写 `package.json`、`src/index.ts`、`cordis.patch.yml`。
3. 在 `configs/cordis.yml` 中挂载你的插件。
4. 运行 `pnpm run build` 构建插件。
5. 运行 `pnpm start` 验证。

详见 [docs/enterprise/PLUGIN_GUIDE.md](./docs/enterprise/PLUGIN_GUIDE.md)。

---

## 核心依赖

- [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh) — DeepSeek Harness 运行时

---

## 许可证

企业内部使用，具体许可证以官方运行时 LICENSE 为准。
