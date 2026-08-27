# ADR-0002：企业品牌插件（@dsh-enterprise/branding）

- 状态：已接受
- 日期：2026-08-26
- 决策者：平台团队
- 上游 pin：`dsh-v0.1.1-rc.2`（`upstream/deepseek-harness` submodule）

## 背景

`feat/data-egress-switch-refactor` 分支的 `emerald-clinical-data-guard`
内置了品牌功能（`src/branding.js`，约 17KB）：tapIndex 全量字符串变换 +
四条 webServer 路由（manifest / favicon / 数据拦截设置 API）+ 设置页开关
注入。该实现有三点与本骨架的契约不符：

1. 品牌与临床业务（出域开关 policy）耦合在同一注册函数里，`registerBranding(ctx, config, policy)`
   的第三个参数是临床策略对象——品牌作为平台层能力无法脱离业务插件复用。
2. 全部注入走 `tapIndex`。rc.2 已提供结构化注入行（`webserver/index-inject`
   事件 + `IndexInjection` 行表），官方 README 明确 tapIndex 是"行无法表达
   的标记"的逃生口；行是 JSON 可序列化的，静态 worker 部署经 boot 载荷吃
   同一张表，tapIndex 只有服务端渲染路径。
3. 环境变量前缀 `EMERALD_*` 与品牌默认值 "Emerald Clinical" 是临床部署
   的业务事实，写死在平台层代码里。

## 决策

### 1. 品牌独立成包，纯平台层

新增 `packages/enterprise/branding`（row `enterprise-branding`），只含品牌
职责：标题、application-name、正文品牌词替换、标志替换、favicon、
manifest。临床出域开关 UI 与 `/api/settings/data-interception` 留在业务
插件迁移时处理（需要其 policy 对象）。

### 2. 官方注入行优先，tapIndex 仅做 title 交换

global 行（品牌配置）+ html 行（meta）+ script 行（客户端脚本）走
`webserver/index-inject`；`<title>` 替换无法表达为行（行只插入 head/body
开标签之后），走 tapIndex 逃生口。客户端脚本行放 body 而非 head：head
行渲染在 `<head>` 开标签内侧，约 4KB 的内联脚本会排在 charset meta 之前，
非 ASCII 品牌名有编码声明滞后于前 1024 字节的风险。

### 3. 不依赖官方 webserver 包，用结构镜像类型

企业包 peer 依赖只有 cordis 内核（与既有三包一致）；`ctx.webServer` 的
服务面与 `webserver/index-inject` 事件签名以本地结构类型 + 模块合并镜像。
官方 loader 在运行时注入真实服务，编译期无需（也无法低成本）解析
`@deepseek-ai/dsh-host-webserver`。若未来该包成为真实依赖，删除镜像与
合并即可，运行时行为不变。

### 4. 品牌信息进 row config，环境变量改中性前缀

`brandName` / `brandShortName` 配置在 `cordis.patch.yml` 的 row config
（CODING_STANDARDS：部署参数禁止写死在插件代码），环境变量兜底改名
`DSH_BRAND_NAME` / `DSH_BRAND_SHORT_NAME`，默认值 `DSH Enterprise` / `DSH`。
校验规则（长度上限、禁尖括号）与输出期 HTML 转义沿袭原实现；替换串一律
经函数形式，规避品牌名中 `$` 序列的替换模式语义（原实现的隐患）。

### 5. 标志替换沿用"只追加、不触碰 React 节点"的策略

官方左上角标志是 React 管理的内联 SVG，`replaceWith`/`remove` 会破坏协调；
沿用 CSS 隐藏 + 追加兄弟节点（favicon img + 品牌名），原实现的
MutationObserver 防抖与折叠栏图标互换的清理逻辑原样保留。跳过标记从
`data-clinical` 泛化为 `data-no-brand`。

2026-08-26 对上游 rc.2 客户端源码做过一次 "DeepSeek 字样" 全量排查：客户端
包里的 "DeepSeek" 绝大多数是代码注释与标识符（不渲染）；真正渲染面是
wordmark SVG（CSS 隐藏 + 替换）、文本节点（TreeWalker）、以及动态拼接的
展示属性——如模型选择器 `aria-label="选择模型，当前 DeepSeek-…"`。TreeWalker
只走文本节点，因此客户端脚本在文本遍历之外增加了对 `aria-label` / `title` /
`alt` / `placeholder` 四类属性的同样替换，两处共用同一跳过判定与替换函数。

## 后果

- 企业 row 从 3 个增至 4 个；`scripts/` 一行未改（自动发现）。
- 临床插件未来迁入时，其品牌调用点删除，改由本层承担；其设置开关 UI
  需要 `settings.general.item` 插槽注入时，可复用本包的行注入手法，但
  属于独立实现。
- `brandName` / `brandShortName` 长度与字符约束在 `validateBrandingConfig`
  强制；`cordis.patch.yml` 中配置的临床部署值（如 Emerald Clinical）由
  各部署自行维护，平台默认值保持中性。
- favicon 暂为包内固定资产；按部署换标目前靠改 `assets/branding/favicon.svg`
  文件，路径可配置化留待有真实多品牌需求时再议（避免过早引入任意路径
  读取的安全面）。
