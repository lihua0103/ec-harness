# DSH Enterprise Platform

`@dsh-enterprise/platform` 是 DeepSeek Harness 的企业扩展平台。它不 fork 官方实现，而是把官方源码固定为 git submodule，把企业能力做成外挂 Bundle，通过官方自有的 profile/bundle 扩展机制注入运行时。目标是让企业实现与上游演进彻底解耦：升级上游只需移动 submodule 指针，企业代码一行不动。

当前上游 pin：`upstream/deepseek-harness` @ `dsh-v0.1.1-rc.2`。

## 1. 为什么是这个形态

在 AI Agent 运行时上做企业二次开发，通常有三条路，各自的代价很不一样。

直接 fork 并改官方源码，起步最快，但每次上游发版都要做一次三方合并，企业改动散落在官方文件里，冲突面随时间单调增长。用猴子补丁在运行期改官方行为，避免了合并冲突，但依赖的是官方私有实现细节，上游一次内部重构就会在运行期而非构建期崩掉。第三条路是只使用官方声明的扩展点：这需要先确认扩展点的表达力足够，代价是要接受官方装配机制的全部契约。

本平台选第三条。DeepSeek Harness 的 cordis 内核已经提供了正式的分层装配：包 manifest 声明 `dsh.bundle.patch`，profile manifest 声明 `dsh.profile.bundles`，官方 `loadProfile` 按 bundles 顺序把各层 patch 依次叠加成最终插件树。企业层要做的只是提供若干 patch 层和一个装配清单，官方源码目录保持只读。

这个选择的直接后果是：企业不得修改 `upstream/deepseek-harness/` 下的 `packages/`、`vendor/`、`apps/`，也不得把官方源码复制到别处；跨越这条线的行为由 `scripts/check-architecture.mjs` 在门禁阶段拦下，而不是靠 code review 的记性。

## 2. 分层与目录

```text
upstream/deepseek-harness/     官方 Harness 基线，git submodule，只读
packages/enterprise/           企业插件实现（每个包 = 一个 Bundle = 一个 patch 层）
  tool-audit/                  通用车道数据集护栏（tools/pre-execute，ADR-0007）
  ui-settings/                 企业设置面板
  branding/                    企业白标（标题/正文品牌词/标志/favicon/manifest）
  listing/                     临床 Listing 引导流程（spec/ALS → SAS → Excel，不限 AI 操作）
profiles/enterprise/           装配层：bundles 顺序 + link: 依赖 + 自有 patch
scripts/                       治理与编排：门禁检查、上游同步、启动链路
tests/architecture/            装配契约测试
docs/enterprise/               架构、规范、ADR、运行手册
```

四层的职责边界是：官方层提供能力与扩展点；插件层实现企业行为，彼此之间只通过类型化 Service 与 Event 通信，不用全局变量；装配层决定哪些插件参与、以什么顺序叠加；治理层保证前三层的契约可被机器验证。

企业包统一使用 `@dsh-enterprise/*` 命名，官方包保持 `@deepseek-ai/dsh-*`。企业包不得伪装成官方包名，因为官方 loader 按 `name` 字段做 Node 模块解析，命名冲突会表现为难以定位的加载错误。

## 3. 装配契约

这一节是全平台最容易出错的地方。以下每条都在官方 `dsh-v0.1.1-rc.2` 源码中逐条验证过，偏离任何一条都会导致启动失败，且错误信息通常指向表象而非根因。

`DSH_HOME` 必须是仓库根，不是 `profiles/`。官方 `resolveProfileDir` 的实现是 `join(home, 'profiles', name)`，把 `DSH_HOME` 指到 `<root>/profiles` 会让官方去找 `profiles/profiles/enterprise`。另外，`enterprise` 不在官方 `PROFILE_TEMPLATES`（只有 `web` 和 `headless`）里，不会被自动初始化。

profile 目录必须是独立的 pnpm 根，不能收进企业 workspace。官方 `initProfile` 会为该目录写入 `packages: [.]` + `nodeLinker: hoisted`，并在 `$DSH_HOME/profiles/node_modules` 维护一份扁平回退 symlink，供 out-of-tree 插件解析官方 Service Definition 包。企业 workspace 的模块布局假设与之冲突，因此根 `pnpm-workspace.yaml` 只含 `packages/enterprise/*`，profile 由 `pnpm run profile:install` 独立安装。

Bundle 解析走两个锚点。官方先在 installation（`apps/cli/package.json`）处解析，再回落到 profile 目录，用 `resolve.paths()` 加 `existsSync` 探测目录，刻意绕过 `exports`，所以企业包无需导出 `./package.json`。

`bundles` 与 `dependencies` 两处都要写。前者定 patch 层顺序，后者决定官方能否从 profile 目录解析到该包；只写 bundles 会在 boot 期报 `cannot resolve profile bundle`。而 `link:` 声明必须真正跑过一次 `pnpm install` 才会落成 symlink。

企业 Bundle 必须排在 `@deepseek-ai/dsh-web-app` 之后。后加载的 patch 层才能覆盖前层的 row，顺序反了则企业配置静默失效。

每个企业包的 `cordis.patch.yml` 至少要有一个 row，`id` 用 `enterprise-` 前缀，`name` 与包名逐字相同。空 `[]` 能通过 YAML 校验，但插件根本不会被挂载——这类"配置合法但语义为空"的失败由装配契约测试拦下。

pnpm 11 起，workspace 级设置由 `pnpm-workspace.yaml` 承载。`strictPeerDependencies`、`saveExact`、`autoInstallPeers`、`engineStrict` 等键写在 `.npmrc` 里会**静默失效**（`pnpm config get` 返回 `undefined`），lockfile 按默认值生成，最终以 `--frozen-lockfile` 硬失败的形式暴露。本仓库已删除 `.npmrc`，架构检查会拦住往回加键的回退。

`profiles/*/cordis.yml` 由官方每次 boot 无条件重写，必须 gitignore；该编辑的文件是 `cordis.patch.yml`。

当前装配现状：162 个官方 row + 4 个企业 row（`enterprise-tool-audit` / `enterprise-ui-settings` / `enterprise-branding` / `enterprise-listing`），profile 自有 patch 为空。

## 4. 治理：可执行的规范

架构规范如果只写在文档里，实际约束力为零。本平台的原则是每条可机检的条款都必须有对应门禁，`pnpm run check:all` 串起八步（lint→typecheck→test→architecture→secrets→python→upstream→profile:verify）：

| 门禁 | 覆盖内容 |
|---|---|
| `lint` | oxlint，`.oxlintrc.json` 显式配置（此前无配置文件，只跑默认规则集） |
| `typecheck` | `pnpm -r run typecheck`，各包 `tsc -b` |
| `test` | 各包单测 + `tests/architecture` 的装配契约（21 条断言 / 4 组） |
| `check:architecture` | 包命名、`private:true`、`type:module`、patch 是否列入 `files`/`exports`、row id 前缀、`link:` 目标存在性、profile 不得入 workspace、`.npmrc` 失效键、禁止深引官方子路径、企业代码是否泄漏进官方 submodule |
| `check:secrets` | 凭证形态扫描，覆盖"API Key 不得进 cordis.patch.yml"一类此前无人执行的条款 |
| `check:upstream` | submodule pin 与官方基线一致性 |

检查脚本本身也遵守同一条纪律：插件清单由 `scripts/enterprise-plugins.mjs` 遍历 `packages/enterprise/*` 得出，`start.mjs`、`clean.mjs`、`check-architecture.mjs` 都从它取，脚本内一律不硬编码包名。否则漏改的那个脚本会静默跳过新插件。

## 5. 跨平台启动链路

入口是 `start.bat`（Windows）与 `start.sh`（类 Unix），两者都只是 `scripts/start.mjs` 的薄包装，编排逻辑只有一份。启动器依次确认根项目、官方 Harness、企业 profile 的依赖，按需构建缺失的产物，清理端口，然后拉起 WebUI。

这条链路上有两个静默失败陷阱值得单独记住，它们的共同点是退出码都为 0。

npm script 里的单引号在 Windows 上是字面量。`pnpm -r --filter './packages/enterprise/**' run build` 经 cmd.exe 执行时引号不被剥离，pnpm 打印 "No projects matched the filters" 后退出 0，构建零产出。修法是用裸 `pnpm -r run build`——本仓库 workspace 只含 `packages/enterprise/*`，且 `-r` 默认排除根包。也不能改成 `--filter "@dsh-enterprise/*"`，因为根包名 `@dsh-enterprise/platform` 同样命中，会递归自调。

`tsc -b` 只比对 tsbuildinfo 与源文件时间戳，不检查产物是否存在。手删过 `lib/` 之后它会报 "Project is up to date" 并零产出退出 0。因此 `start.mjs` 在构建后校验产物，缺失则清掉 tsbuildinfo 全量重建，再缺失才 fail——凡"检测缺失、自动修复"的步骤都必须复验目标物，不能只信退出码。

端口清理走探测器链而非写死单个工具：Windows 用 `netstat`，类 Unix 依次尝试 `ss` → `lsof` → `fuser`。解析 netstat 输出时不匹配 `LISTENING` 字面量（中文/德文 Windows 会翻译状态列），改判外部地址是否为通配。释放判据是 `net.createServer().listen(127.0.0.1)` 能否绑定，而不是"杀完就算完"；SIGTERM 5 秒不放手再补 SIGKILL，Windows 用 `taskkill /T /F` 连带孙进程（dsh 是 pnpm 的孙进程）。探测工具全缺又端口被占时显式 fail 并提示 `DSH_PORT`。

## 6. 业务插件形态：临床数据护栏

`emerald-clinical-data-guard` 是这套插件模型上的第一个重量级业务实现，它同时说明了扩展点的表达力上限。**该插件目前仍在 `feat/data-egress-switch-refactor` 分支，尚未迁入本骨架**，迁移方案需要单独 ADR。其平台层部分已先行迁出：品牌白标功能独立为 `@dsh-enterprise/branding`（[ADR-0002](./docs/enterprise/adr/0002-enterprise-branding-plugin.md)），注入车道从 tapIndex 全量变换改为官方结构化注入行 + title 逃生口。

当前 Listing 是受信环境中的标准 pandas 执行车道：ADR-0009 已放开 import、文件 IO、动态执行与 DataFrame 读写方法，并在独立子进程中运行；它不等同于 OS 级强沙箱。数据安全开关默认开启，只控制 Listing 回执投影与通用工具的数据集车道；关闭后两类出域拦截均为零，Listing 工具本身不受开关阻断。inspect 数据集只返回结构元数据，run_code 回执只返回输出元数据及有界 stdout/stderr。

模型可见的工具是 `clinical_listing_inspect` → `clinical_listing_run_code`（可多轮迭代）→ `clinical_listing_publish`，加一个 `local_data_metadata`。挂载点用 `tools/post-execute`（结果投影）、`llm/stream`（最终出域检查）、`ctx.tools.register`、`ctx.systemPrompt.section`、`ctx.webServer.tapIndex`。刻意不用 `tools/pre-execute` 拦截通用工具——拦截式设计要穷举攻击面，投影式设计只需定义允许出域的形状。

数据平面判定按路径归属而非内容形态：`data > spec > document > output`，`.sas7bdat` / `.xpt` 无论放在哪都属 data 域。执行车道分为 `fast`（30s）与 `heavy`（600–900s）双 worker，NDJSON over stdio，全链路 fail-closed。`dataInterceptionEnabled` 是唯一的运行态出域开关，关闭时旁路结果投影与流检查，但不影响 Listing 工具本身。

本分支的 `@dsh-enterprise/listing`（ADR-0007 + ADR-0009 现行口径）落地**按源头判定的出域单点**：唯一硬红线是数据集（sas7bdat/xpt/csv）原始行值不出域，inspect 只给元数据；doc/ 文本与 Excel、stdout/AI 产物/错误消息一律不碰。开关是宿主侧的（`DataSecurityService` 设置页），默认开 + fail-closed，关闭 = 零拦截；模型接触不到开关，且开关节不触碰执行面。固定输出模板（Content/Cover/ALS）保留为输出标准，AI 可经 `_skip_default_template` / `_layout` 跳过或接管排版。

## 7. 环境与常用命令

Node `^22.19.0 || >=24.0.0`（与上游对齐，刻意排除官方不支持的 Node 23），pnpm `11.7.0`，Git。

```sh
git submodule update --init --depth 1
pnpm install
pnpm run check:all          # 全量门禁（Profile 装配验证；启动实点用 scripts\start.bat）

pnpm start                  # 一键启动（或双击 scripts\start.bat / ./scripts/start.sh）
pnpm run profile:run        # 只跑 dsh web，叠加企业 patch
pnpm run profile:install    # 独立安装 profile 依赖
pnpm run profile:dump       # 导出最终装配结果

pnpm run upstream:status    # 上游同步三步
pnpm run upstream:sync
pnpm run upstream:verify
```

新增一个企业插件的完整改动面（已实测：加第四个插件时 `scripts/` 一行未改，全部门禁通过）：建包 manifest（`private:true`、`type:module`、`main`/`types` 指向 `lib/index.js`、`files` 与 `exports` 均含 `cordis.patch.yml`、声明 `dsh.bundle.patch`）、tsconfig（`composite`、`rootDir: src`、`outDir: lib`）、至少含一个 row 的 `cordis.patch.yml`、`src/index.ts` 默认导出插件函数，最后在 `profiles/enterprise/package.json` 的 `dependencies` 与 `dsh.profile.bundles` 各加一行。根 `tsconfig.json` 的 `references` 是可选的，只影响 IDE 与根级 `tsc -b`。

## 8. 现状与待办

骨架、装配契约、门禁与跨平台启动链路已可用，`pnpm install --frozen-lockfile` 可用。企业插件中 `branding`（ADR-0002）、`listing`（ADR-0003 + ADR-0007 数据集单规则红线）、`tool-audit`（ADR-0007 通用车道护栏）与 `ui-settings`（开关本体 + 配置单源）均已落地实现；`auth` 已于 08-27 移除（无 ADR 记录，教训见 PLUGIN_SYSTEM_AUDIT_20260828.md §C-1）。CI 尚未建立，门禁靠人工执行 `pnpm run check:all`。临床护栏插件其余部分（出域开关、设置页 UI）的迁入方案待定。

## 9. 文档索引

- [ADR-0001：企业扩展层的边界、分发与 pnpm 基线](./docs/enterprise/adr/0001-enterprise-extension-boundary.md)
- [ADR-0002：企业品牌插件](./docs/enterprise/adr/0002-enterprise-branding-plugin.md)
- [ADR-0003：临床 Listing 引导插件](./docs/enterprise/adr/0003-enterprise-listing-plugin.md)
- [ADR-0005：Listing 场景化数据红线（按源头判定 + 可关闭开关 + 模板保留）](./docs/enterprise/adr/0005-listing-v2-scenario-redline.md)
- [ADR-0006：数据拦截两规则口径与宿主侧开关](./docs/enterprise/adr/0006-data-guard-two-rules-host-switch.md)
- [架构审计](./docs/enterprise/ARCHITECTURE_AUDIT.md)
- [插件架构](./docs/enterprise/PLUGIN_ARCHITECTURE.md)
- [企业代码规范](./docs/enterprise/CODING_STANDARDS.md)
- [开发工作流](./docs/enterprise/DEVELOPMENT_WORKFLOW.md)
- [上游升级手册](./docs/enterprise/runbooks/UPSTREAM_UPGRADE.md)
- [安全与审计](./docs/enterprise/runbooks/SECURITY_AUDIT.md)
- [插件分发](./docs/enterprise/runbooks/PLUGIN_DISTRIBUTION.md)
