# DeepSeek Harness 企业版代码开发规范

> 本规范适用于基于 DeepSeek Harness 的二次开发，所有成员必须遵守。

---

## 1. 包管理（强制 pnpm）

1. **唯一包管理器**：本仓库仅支持 `pnpm`，禁止引入 `npm`、`yarn`、`bun` 的 lock 文件。
2. **版本锁定**：根目录 `package.json` 声明 `packageManager: "pnpm@>=11.7.0"`。
3. **workspace 机制**：所有新增企业包必须加入 `pnpm-workspace.yaml` 的 `packages` 列表。
4. **依赖声明**：
   - 跨包依赖使用 `workspace:^`。
   - 禁止使用 `*` 或 `latest`。
   - 禁止直接依赖 `node_modules/.pnpm` 内部路径。
5. **安装命令**：
   ```sh
   pnpm install
   ```
6. **新增依赖**：
   ```sh
   pnpm --filter @deepseek-ai/dsh-<pkg> add <dep>
   ```

---

## 2. 工程结构

### 2.1 目录约定

```
packages/<group>/<pkg>/
  src/             # 源码（ESM TypeScript）
  tests/           # 单元/集成测试
  package.json     # 必须声明 type: module
  tsconfig.json    # 继承根 tsconfig.base.json
  README.md        # 包职责、扩展点、示例
  README.i18n.yaml # 双语摘要
```

### 2.2 新增包的命名

- **官方能力包**：`@deepseek-ai/dsh-<group>-<name>`
- **企业扩展包**：建议 `@<company>/dsh-<feature>` 或 `packages/enterprise/*` 内的 `@deepseek-ai/dsh-enterprise-<feature>`
- 不得使用 `@deepseek-ai` 命名与企业无关的私有业务包。

### 2.3 文件组织

- 一个文件一个主要职责。
- 服务定义放 `src/index.ts`，invariant 放 `src/invariant.ts`。
- 测试文件命名：`<module>.spec.ts` 或 `<module>.e2e.ts`。

---

## 3. TypeScript / ESM 规范

1. **ESM only**：每个 `package.json` 必须 `"type": "module"`。
2. **导入约定**：
   - 跨包使用包名：`import { X } from '@deepseek-ai/dsh-llm'`。
   - 包内相对导入使用 `.ts` 扩展名：`import { X } from './foo.ts'`。
   - 禁止使用 CJS (`require`/`module.exports`)。
3. **类型导出**：公共 API 必须通过 `exports` 字段显式导出，禁止 deep import 内部文件。
4. **编译面**：
   - host 包走 `tsconfig.host.json`。
   - client 包走 `tsconfig.client.json`。
   - 每个包只使用一个聚合 tsconfig。

---

## 4. Cordis 插件开发规范

1. **插件即服务**：通过 `ctx.effect()` / `ctx.on()` 注册，确保卸载时可逆。
2. **事件命名**：
   - 会话事件：`session/*`
   - Agent 事件：`agent/*`
   - 能力事件：`tools/*`、`fs/*`、`llm/*`
3. **瀑布事件必须调用 next()**：在 waterfall listener 中返回前必须 `await next()`。
4. **新增能力缝必须三位一体**：Service Definition + Provider + Consumer 在同一 PR 内完成。
5. **配置外露**：部署差异项必须在 `cordis.patch.yml` 中作为 `config` 字段，禁止在代码中硬编码。
6. **模型可见内容必须入日志**：任何会进入模型请求的内容必须生成 `SessionEvent`。

---

## 5. UI 开发规范

1. **UI 插件包命名**：`@deepseek-ai/dsh-client-ui-<feature>`。
2. **视图注册**：通过 `ui-renderer` / `ui-slots` 注册，禁止直接操作 `#root`。
3. **React 规范**：
   - 函数组件 + Hooks。
   - Props 显式类型化，避免 `any`。
4. **样式**：
   - 优先使用 CSS Modules（`.module.css`）。
   - 企业主题统一放在 `packages/enterprise/theme`。
5. **状态**：
   - 服务端/会话状态走 Cordis 服务。
   - 纯 UI 状态可用 React Context/Reducer，禁止直接依赖全局变量。

---

## 6. 测试规范

1. **测试框架**：vitest。
2. **最小覆盖**：核心包 `src/` 下每个文件必须被至少一个测试覆盖。
3. **测试分类**：
   - 单元测试：`*.spec.ts`
   - 集成测试：涉及真实 provider 的用 `*.e2e.ts`，无 key 时 `it.skip`。
4. **禁用网络**：单元测试不得访问真实网络，使用 mock server 或 vi.fn。
5. **运行命令**：
   ```sh
   pnpm run test
   pnpm run test:gui
   ```

---

## 7. Lint / 代码质量

1. **Linter**：oxlint（`.oxlintrc.json`）。
2. **提交前必须执行**：
   ```sh
   pnpm run lint
   pnpm run typecheck
   pnpm run test
   ```
3. **禁止提交**：
   - 注释掉的调试代码。
   - `console.log`（测试代码除外）。
   - `any` 泛滥。
   - 硬编码密钥、API URL、环境相关常量。
4. **Git Hooks**：仓库保留 `lefthook`，安装时自动注册 pre-commit/pre-push 钩子。

---

## 8. 提交与版本规范

1. **分支策略**：
   - `main`：稳定分支。
   - `codex/<feature>`：功能分支。
   - `fix/<issue>`：修复分支。
2. **提交信息格式**：
   ```
   <type>(<scope>): <subject>
   ```
   - type: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`
   - scope: 包名或模块名
3. **版本发布**：
   - 修改 `package.json` 版本。
   - 生成 `CHANGELOG.md`。
   - 使用 `pnpm run build` 验证产物。

---

## 9. 安全规范

1. **凭证管理**：
   - API Key、Token 必须走 `dsh-credentials` 或环境变量，禁止写进代码/配置。
   - `.env` 文件必须加入 `.gitignore`。
2. **沙箱执行**：
   - 外部命令必须通过 `ctx.subprocess` + `ctx.sandbox` 执行。
   - 禁止直接 `child_process.spawn`。
3. **依赖审计**：
   - 新增 npm 包需经过安全评审。
   - 定期执行 `pnpm audit`。

---

## 10. 文档规范

1. 每个新增包必须包含 `README.md`，说明：
   - 职责
   - 扩展点
   - 配置示例
   - 测试方式
2. 架构变更必须同步更新 `ENTERPRISE_ARCHITECTURE.md`。
3. 双语：中文为主，英文可选。

---

## 11. 快速检查清单

提交 PR 前确认：

- [ ] 使用 pnpm 安装并通过 `pnpm run build`。
- [ ] `pnpm run lint` 无错误。
- [ ] `pnpm run typecheck` 通过。
- [ ] 新增包已加入 `pnpm-workspace.yaml`。
- [ ] 新增包已声明 `type: module`。
- [ ] 未引入新的 npm/yarn lock 文件。
- [ ] 无硬编码凭证、URL、路径。
- [ ] 已添加/更新对应测试。
- [ ] 已更新 README / 架构文档。
