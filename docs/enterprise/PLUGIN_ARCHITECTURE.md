# DSH 企业插件架构

## 1. 目标目录

```text
packages/
  enterprise/
    auth/
      package.json
      src/
      tests/
    llm-corporate/
      package.json
      src/
      tests/
    tool-audit/
      package.json
      src/
      tests/
    ui-corporate-settings/
      package.json
      src/
      tests/
profiles/
  enterprise/
    package.json
    cordis.patch.yml
docs/
  enterprise/
```

企业插件包使用 `@dsh-enterprise/*` 命名，官方包继续使用 `@deepseek-ai/dsh-*`。企业包不得伪装成官方包。

## 2. 企业 Profile

`profiles/enterprise/package.json` 只声明企业 profile 元数据和企业插件依赖：

```json
{
  "name": "@dsh-enterprise/profile",
  "private": true,
  "type": "module",
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@dsh-enterprise/tool-audit"
      ]
    }
  }
}
```

企业 patch 只插入或替换企业 row。替换官方 row 必须有架构记录和升级测试。

## 3. 扩展点选择

| 企业需求 | 首选扩展点 |
|---|---|
| 接入企业模型 | `ctx.llm` Provider |
| 增加模型工具 | `ctx.tools` Consumer |
| 工具审计/脱敏 | `tools/*` waterfall 或 telemetry capability |
| 登录与凭证 | credentials/identity Service |
| 文件访问控制 | `ctx.fs` Provider 或 `fs/*` policy event |
| 命令执行安全 | `ctx.subprocess`、`ctx.sandbox` Provider |
| 新增会话事实 | `SessionEventMap` + projection |
| 新增 WebUI 页面 | client UI plugin + renderer/slots |
| 新增设置项 | settings Service + UI settings card |
| 任务编排 | `ctx.jobs` 或 workflow capability |

## 4. 插件实现约束

插件入口必须是 ESM，并通过官方服务和事件注册。禁止直接导入官方包的 `src` 私有路径，禁止修改官方 package 的 package.json，禁止在企业插件中复制 Agent Loop。

企业插件只依赖公开 exports，并通过 `workspace:^` 依赖同一工作区的官方包。跨插件通信使用类型化 Service 或 Event，不使用全局变量。

## 5. 官方升级策略

仓库配置：

```sh
git remote add upstream https://github.com/deepseek-ai/deepseek-harness.git
git fetch upstream
```

升级流程：

1. 在独立 `upgrade/upstream-<version>` 分支同步官方。
2. 只解决官方目录与官方 lockfile 的冲突。
3. 运行官方 build/typecheck/test。
4. 运行企业 profile 的装配测试。
5. 运行企业插件测试。
6. 通过后合并到企业主分支。

企业插件目录、企业 profile、企业文档不参与官方文件覆盖。若必须覆盖官方 row，只能在企业 patch 中完成，并记录原 row 版本与升级验证结果。
