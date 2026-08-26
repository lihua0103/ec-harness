# DSH 企业插件代码规范

## pnpm

- 仅允许 pnpm，禁止提交 `package-lock.json`、`yarn.lock`、`bun.lockb`。
- 依赖使用 `workspace:^` 或固定版本，禁止 `latest`。
- 根目录 `packageManager` 固定为仓库要求的 pnpm 版本。
- 依赖安装、脚本调用、CI 命令统一使用 `pnpm`。

## TypeScript

- ESM only，所有包声明 `"type": "module"`。
- 使用 NodeNext 模块解析。
- 公共 API 必须通过 `exports` 暴露。
- 相对导入保留 `.ts` 扩展名，跨包使用包名。
- 开启 strict，禁止无理由使用 `any`。

## Cordis

- 插件注册必须可卸载。
- waterfall listener 必须调用 `next()`。
- 新能力必须同时定义 Service、Provider、Consumer。
- 配置项放在 `cordis.patch.yml`，禁止把部署参数写死在插件代码。
- 会进入模型请求的内容必须能够从 Session Log 重建。

## 企业边界

- 不修改 `vendor/`、`packages/core/`、官方 `packages/*`、`apps/*`。
- 企业代码只放 `packages/enterprise/*` 和 `profiles/enterprise/*`。
- 企业包名使用 `@dsh-enterprise/*`。
- 企业 row id 使用 `enterprise-` 前缀。
- 企业插件只能依赖官方公开 exports。

## 测试

每个企业插件至少包含：

- Service/Provider 单元测试。
- 插件加载与卸载测试。
- Profile 装配测试。
- 影响 WebUI 时增加 UI 渲染测试。
- 影响模型可见内容时增加 Session Log/replay 测试。

## 提交

```text
feat(enterprise-auth): add SSO credential provider
fix(tool-audit): redact credential fields
chore(upstream): sync dsh <version>
```
