# 企业插件分发

## 决定：不发布，只 link（ADR-0001）

企业插件一律 `private: true`，通过 profile 的 `link:` 依赖进入官方运行时。
`scripts/check-architecture.mjs` 与 `tests/architecture/profile-assembly.test.ts`
共同强制这条约束。

理由是内部插件误发布到公网 npm 是不可逆事故（包名一旦占用无法真正撤回，
且企业逻辑与内部服务地址会外泄），而 `private: true` 是成本最低、最难绕过的
一道防线。企业内部无需版本化分发就能满足当前需求：profile 与插件源码同仓库
同提交，天然一致。

## 依赖声明形态

`profiles/enterprise/package.json`：

```json
{
  "dependencies": {
    "@dsh-enterprise/auth": "link:../../packages/enterprise/auth"
  },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@dsh-enterprise/auth"] } }
}
```

两处都要写：`bundles` 决定 patch 层顺序，`dependencies` 决定官方
`resolveBundleDir` 能否从 profile 锚点解析到包。只写 `bundles` 会在 boot 期
报 `cannot resolve profile bundle`。

`link:` 声明必须经 `pnpm install`（即 `pnpm run profile:install`）落成
`profiles/enterprise/node_modules/` 下的真实 symlink 才生效。`pnpm run start`
已包含这一步。

## profile 目录是独立 pnpm 根

`profiles/enterprise/` **不是**企业 workspace 成员，它有自己的
`pnpm-workspace.yaml`（`packages: [.]` + `nodeLinker: hoisted`）。这是官方
`initProfile` 的契约：官方会在 `$DSH_HOME/profiles/node_modules` 维护一份
扁平回退符号链接目录，把 profile 收进企业 workspace 会让两套模块布局假设
互相冲突。架构检查会拦住这种回退。

## 版本策略

- 插件与 profile 同仓库同提交，版本由 git 提交决定，不依赖 SemVer 协商。
- 官方 Harness 版本由 `upstream/deepseek-harness` submodule 的 pin 固定
  （当前 `dsh-v0.1.1-rc.2`），升级流程见 `UPSTREAM_UPGRADE.md`。
- 企业包对官方运行时的兼容性用 `peerDependencies` 声明（`@deepseek-ai/cordis`），
  不用普通 dependencies，避免装出第二份 Cordis。
- 不允许运行时从 GitHub 分支直接加载企业插件。

## 若将来确需私有 registry

改为可发布是架构变更，必须新增 ADR，并同时调整：

1. 去掉相关包的 `private: true`，加 `publishConfig.registry` 指向内部 registry；
2. `scripts/check-architecture.mjs` 把 `private:true` 断言换成
   "要么 private，要么 publishConfig.registry 为内部地址"；
3. `tests/architecture/profile-assembly.test.ts` 中对应断言同步放宽；
4. profile 依赖从 `link:` 改为固定版本号，并锁定 profile lockfile。

在完成上述四项之前，不要执行 `pnpm publish`——`private: true` 会阻止它，
这是预期行为，不是故障。
