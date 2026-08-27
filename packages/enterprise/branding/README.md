# 企业品牌插件

`@dsh-enterprise/branding` 是 WebUI 白标层：把官方 DeepSeek Harness 界面
换成企业自有品牌。源流是 `feat/data-egress-switch-refactor` 分支
`emerald-clinical-data-guard` 的 `src/branding.js`，迁入本骨架时按官方
`dsh-v0.1.1-rc.2` 的扩展点重排，决策记录见
[ADR-0002](../../../docs/enterprise/adr/0002-enterprise-branding-plugin.md)。

## 提供什么

- `<title>` 与 `application-name` 品牌化（tapIndex 逃生口——行机制只能插入、不能替换）。
- 正文品牌词替换：`DeepSeek (Harness)` → 品牌名，`\bDSH\b` → 短名；覆盖
  文本节点与展示属性（`aria-label` / `title` / `alt` / `placeholder`，TreeWalker
  不走属性，读屏器读的正是这些）；带 `data-no-brand` 祖先容器的节点跳过。
- 左上角与折叠栏标志替换：CSS 隐藏官方内联 SVG，追加 favicon 图标与品牌名。
- `/favicon.svg`（包内资产）与 `/manifest.webmanifest`（品牌化 PWA manifest）
  两条具名路由，均 `no-store`。
- 官方结构化注入行（`webserver/index-inject`）：global 行携带品牌配置、
  meta 行、body 起始处的客户端脚本行；服务端渲染与静态 worker 部署共用同一张表。

## 配置

品牌信息放 `cordis.patch.yml` 的 row config，禁止写死在代码：

```yaml
- insert:
    - id: enterprise-branding
      name: '@dsh-enterprise/branding'
      config:
        brandName: DSH Enterprise
        brandShortName: DSH
```

约束：`brandName` 1..80 字符、`brandShortName` 1..24 字符，均禁尖括号
（构建期校验，输出期再做 HTML 转义）。环境变量 `DSH_BRAND_NAME` /
`DSH_BRAND_SHORT_NAME` 可作兜底覆盖，优先级低于 row config。favicon 固定为
包内 `assets/branding/favicon.svg`，换标替换该文件即可。

## 非目标

业务开关 UI（如临床出域拦截的设置项与 `/api/settings/data-interception`）
依赖业务插件自己的 policy 对象，不属于品牌层；它们随各自的业务插件迁入，
需要设置面板行注入时可复用本包的"结构化行 + MutationObserver 重注入"手法。
