# ADR-0001：企业扩展层的边界、分发与 pnpm 基线

- 状态：已接受
- 日期：2026-08-26
- 决策者：平台团队
- 上游 pin：`dsh-v0.1.1-rc.2`（`upstream/deepseek-harness` submodule）

## 背景

企业需要在 DeepSeek Harness 上做二次开发，同时要求上游可持续升级。首轮骨架
搭好后做了一次架构审计，发现方向正确但若干契约与官方实现不符，且治理规范
只存在于文档、未被任何机制执行。本 ADR 记录这一轮修正涉及的决策。

## 决策

### 1. 企业代码只以外挂 Bundle 形态进入官方运行时

官方源码作为 git submodule 固定在 `upstream/deepseek-harness`，企业实现放在
`packages/enterprise/*`，装配放在 `profiles/enterprise`。企业不修改
`vendor/`、`packages/*`、`apps/*`，也不复制官方源码到别处。

原因是官方的 profile/bundle 机制已经提供了正式扩展点：包 manifest 声明
`dsh.bundle.patch`，profile manifest 声明 `dsh.profile.bundles`，官方
`loadProfile` 按顺序叠加 patch 层。走这条路，上游升级只需移动 submodule 指针。

### 2. `DSH_HOME` 是仓库根，不是 `profiles/`

官方 `resolveProfileDir` 的实现是 `join(home, 'profiles', name)`。此前脚本把
`DSH_HOME` 设为 `<root>/profiles`，导致官方去找
`<root>/profiles/profiles/enterprise`，boot 期报 `profile "enterprise" does not
exist`。企业 profile 又不在官方 `PROFILE_TEMPLATES`（只有 `web` / `headless`）里，
不会被自动初始化。

**如何应用：** 任何调用官方 CLI 的脚本一律 `DSH_HOME=<repo root>`。

### 3. profile 目录是独立 pnpm 根，不是企业 workspace 成员

官方 `initProfile` 会为 profile 目录写 `packages: [.]` + `nodeLinker: hoisted` +
`autoInstallPeers: false`，并在 `$DSH_HOME/profiles/node_modules` 维护一份扁平
回退 symlink 目录，供 out-of-tree 插件解析官方 Service Definition 包。若把
`profiles/*` 收进企业 `pnpm-workspace.yaml`，两套模块布局假设冲突。

因此根 workspace 只含 `packages/enterprise/*`；profile 有自己的
`pnpm-workspace.yaml`，由 `pnpm run profile:install` 独立安装。

### 4. 企业插件保持 `private: true`，通过 `link:` 分发，不发布

见 `runbooks/PLUGIN_DISTRIBUTION.md`。此前 `check-architecture.mjs` 强制
`private: true` 而分发手册教 `pnpm publish`，两者互斥且不可能同时成立。

选择不发布，因为内部插件误发布到公网 npm 不可逆，而当前需求（插件与 profile
同仓库同提交）不需要版本化分发。改为可发布需新增 ADR 并同步四处约束。

### 5. pnpm 基线设置写在 `pnpm-workspace.yaml`，删除 `.npmrc`

pnpm 11 起 `strictPeerDependencies` / `saveExact` / `autoInstallPeers` /
`engineStrict` 等 workspace 级设置由 `pnpm-workspace.yaml` 承载。此前这些键写在
`.npmrc`，实测 `pnpm config get auto-install-peers` 返回 `undefined`——**全部
静默失效**，lockfile 按默认值 `autoInstallPeers: true` 生成，与 `.npmrc` 声明
相反，`--frozen-lockfile` 因此硬失败。

`.npmrc` 已删除，键迁至 `pnpm-workspace.yaml`；架构检查会拦住往 `.npmrc`
重新加键的回退。

### 6. `engines.node` 与上游对齐为 `^22.19.0 || >=24.0.0`

此前根 manifest 写 `>=22.19.0`，会放进上游明确不支持的 Node 23。配合
`engineStrict: true`，这个偏差会在安装期咬人。企业各包与上游取同一区间。

### 7. 治理靠可执行检查，不靠文档

新增/重写了以下机制，取代原先只写在规范里的条款：

- `scripts/check-architecture.mjs`：不再硬编码包名白名单，改为遍历
  `packages/enterprise/*` 并从 profile manifest 反推允许的 Bundle；新增
  `.npmrc` 失效键、profile 不得入 workspace、patch 必须列入 `files`/`exports`、
  企业 row id 前缀、`link:` 目标存在性、官方 submodule 未被写入等断言。
- `scripts/check-secrets.mjs`：凭证形态扫描，覆盖 `SECURITY_AUDIT.md` 中
  "API Key 不得进 cordis.patch.yml" 等此前无人执行的条款。
- `tests/architecture/profile-assembly.test.ts`：25 条装配契约测试，按官方真实
  解析规则验证 Bundle 顺序、row id 唯一性、patch 可解析性。
- `.oxlintrc.json`：此前 lint 无配置文件，只跑默认规则集。
- 根 `package.json` 的 build/typecheck/test 改用 `pnpm -r run <script>`，新增插件不再
  需要改四处脚本。**不要写成 `--filter './packages/enterprise/**'`**：npm script 里的
  单引号在 Windows 上不被 cmd.exe 剥离，过滤器会带着引号字面量下去，pnpm 打印
  "No projects matched the filters" 然后**退出 0**，构建静默零产出。也不要写成
  `--filter "@dsh-enterprise/*"`：根包名 `@dsh-enterprise/platform` 同样命中会递归自调。
  裸 `-r` 在本仓库是准确的——workspace 只含 `packages/enterprise/*`（见决策 3），
  且 `-r` 默认排除根包。
- 插件清单统一由 `scripts/enterprise-plugins.mjs` 遍历 `packages/enterprise/*` 得出，
  `start.mjs` / `clean.mjs` 都从它取；脚本内一律不硬编码包名，否则漏改的那个脚本会
  静默跳过新插件。

### 8. 不跟踪 `.agents/` 与 `profiles/*/cordis.yml`

`.agents/` 的 2246 个文件与 `upstream/deepseek-harness/.agents` 逐字重复，企业层
无需再存一份。`profiles/*/cordis.yml` 由官方每次 boot 无条件重写，跟踪它会造成
永久脏工作树；应编辑的是 `cordis.patch.yml`。

## 后果

正面：启动链路与官方契约一致，`pnpm install --frozen-lockfile` 可用；规范中
可机检的条款已全部有对应门禁；新增插件不需要改任何脚本。

新增一个企业插件的完整改动面（已实测：加第四个插件 `scripts/` 一行未改，
六道门禁全过）：

1. `packages/enterprise/<name>/package.json`——`private:true`、`"type":"module"`、
   `main`/`types` 指向 `lib/index.js`、`files` 与 `exports` 都要含 `cordis.patch.yml`、
   声明 `dsh.bundle.patch: ./cordis.patch.yml`、build/typecheck/test 三个脚本。
2. `packages/enterprise/<name>/tsconfig.json`——`composite: true`、`rootDir: src`、
   `outDir: lib`（`lib/index.js` 这个入口是官方 loader 唯一认的路径）。
3. `packages/enterprise/<name>/cordis.patch.yml`——**必须至少有一个 row**，
   `id` 用 `enterprise-` 前缀，`name` 与包名逐字相同（官方按 name 做 Node 解析）。
   空 `[]` 会通过 YAML 校验但插件根本不会被挂载，装配契约测试会拦下。
4. `packages/enterprise/<name>/src/index.ts`——默认导出插件函数。
5. `profiles/enterprise/package.json`——`dependencies` 加 `link:` 一行，
   `dsh.profile.bundles` 加一行（必须排在 `@deepseek-ai/dsh-web-app` 之后）。
   两处都要写：前者决定能否解析，后者定 patch 层顺序。

根 `tsconfig.json` 的 `references` 是可选的——`pnpm -r run build` 在每个包目录各跑
一次 `tsc -b`，不经过根 tsconfig；加它只影响 IDE 与根级 `tsc -b`。

负面与待办：企业插件仍是空壳（`auth` / `tool-audit` / `ui-settings` 的
`ctx.effect()` 内只有 TODO），实现需各自新增 ADR；CI 尚未建立，五道门禁目前靠
人工执行 `pnpm run check:all`；`emerald-clinical-data-guard` 仍在
`feat/data-egress-switch-refactor` 分支，尚未迁入本骨架，迁移方案需单独 ADR。
