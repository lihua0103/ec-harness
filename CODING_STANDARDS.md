# DSH Guard 代码开发规范

## 1. 包管理

- 仅使用 **pnpm**，禁止 npm/yarn。
- `packageManager`: `pnpm@>=11.7.0`。
- 企业插件统一放在 `packages/enterprise/*`。
- 跨包依赖使用 workspace 协议。

## 2. 技术栈

- TypeScript 6.x，ESM only。
- Node.js ^22.19 || >=24。
- Cordis 插件框架。

## 3. 插件开发

- 插件入口 `src/index.ts` 导出 `apply(ctx: Context)`。
- 所有贡献通过 `ctx.effect()` / `ctx.on()`，保证可卸载。
- 配置项放在 `cordis.patch.yml`。

## 4. 代码风格

- 函数组件、显式类型、避免 `any`。
- 文件命名小写，短横线连接。
- 注释说明"为什么"，而非"做什么"。

## 5. 提交规范

```
<type>(<scope>): <subject>
```

type: feat, fix, docs, refactor, test, chore。

## 6. 安全

- API Key 进 `.env`，禁止写代码。
- 外部命令通过 Cordis 服务执行，禁止裸 `child_process`。
