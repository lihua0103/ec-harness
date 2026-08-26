# DSH Guard 快速开始

## 1. 安装

```sh
pnpm install
```

## 2. 配置

```sh
cp .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY
```

## 3. 启动

```sh
pnpm start
```

访问 [http://127.0.0.1:3080](http://127.0.0.1:3080)。

## 4. 开发企业插件

参考 `packages/enterprise/auth/`。

## 5. 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm start` | 启动 Web UI |
| `pnpm run dev` | 启动 Web UI（不自动打开浏览器） |
| `pnpm run build` | 构建企业插件 |
| `pnpm run typecheck` | TypeScript 类型检查 |
