# T07/T09 成果、输入批次与体验验证证据

时间：2026-11-12。环境：Windows 11；Node 24.9.0；上游 `0.2.2-rc.1` @ `fcc0ad46`（源码零改动）。
隔离 profile：`.runtime/nw-web-home`；控制面：`.runtime/nw-t07-home` 合成数据；端口 3095/3096。

## 被测能力（T07）

- 控制面新增 `GET/POST /api/works/:id/input-baselines`（只追加、分页、归档拒绝）。
- 原生工作台整页新增工作详情：运行历史分页、成果列表（封存/未封存、摘要、大小、下载）、
  本次执行输入分页、Work 级输入批次分页；空状态如实说明。
- 下载经同源 `/platform-workbench` 代理；代理转发 `content-disposition`/`content-length`，
  不转发控制面内部头。

## 被测能力（T09）

- `.ec-wb` 作用域样式：宿主 `--dsw-*` token 回退、暗色、窄屏单列、紧凑密度、
  `:focus-visible`、`prefers-reduced-motion`；卸载时移除 `<style>`。
- 错误恢复：每段读取独立错误码与“重试”；不覆盖为占位数据。
- 键盘：进入详情后标题获得焦点；所有操作是原生 button/link。

## 合成数据

- 1 个项目、2 个工作（一个有运行、一个空状态）、1 个运行（SUCCEEDED）、12 个封存成果、
  13 条执行输入、12 个输入批次、1 个绑定。
- 数据由 `scripts/native-workbench-seed-reports.mjs` 生成，明确标注合成，不含业务资料。

## 浏览器结果：22/22 PASS

完整报告：`evidence/t07-t09-browser.json`。要点：

| 检查 | 结果 |
|---|---|
| 工作台面板打开、工作列表真实 | PASS |
| 详情显示运行历史（1）、成果（12）、执行输入（13）、输入批次（12） | PASS |
| 成果分页到第 2 页且总数保持“第 11–12 项，共 12 项” | PASS |
| 封存成果下载 200、保留文件名、字节与摘要一致 | PASS |
| 空工作显示“此工作还没有执行记录”，不伪造成果 | PASS |
| 紧凑布局切换后数据不丢失 | PASS |
| 390×844 窄屏无横向溢出 | PASS |
| 暗色主题：文本 `rgb(249,250,251)`、背景 `rgb(21,21,23)`、`color-scheme: dark` | PASS |
| 注入 503 后显示 `CONTROL_PLANE_UNAVAILABLE` 与重试；解除后重试恢复 | PASS |
| 详情标题获得焦点（H1） | PASS |
| 除注入的 503 资源错误外无控制台错误 | PASS |

截图：

- `t07-workbench-list.png`、`t07-work-detail.png`、`t07-artifact-page-2.png`、`t07-empty-state.png`
- `t09-compact.png`、`t09-narrow.png`、`t09-dark.png`、`t09-error-recovery.png`

## 过程中发现并修复

1. **默认 `fetch` 失去全局接收者**：浏览器报 `Illegal invocation`，页面显示“无法连接平台控制面”。
   修复为构造时 `bind(globalThis)`，并新增回归测试（默认 fetch 的 receiver 必须是 `globalThis`）。
2. **详情页重复 `.ec-wb` 根节点**：外层 shell 与详情组件各渲染一个，导致选择器歧义；移除多余包装。
3. **列表页缺少紧凑开关**：详情页补上同一开关，避免切换视图丢失偏好。

## 未验证（不写成完成）

- 真实业务成果、业务审核绑定与 Listing/DVP 专属边界（无业务切片）。
- 集中部署下的成果下载授权与跨域隔离。
- 卸载/禁用往返的 slot/style 清理（`ctx.effect` 已写清理，但未做 enable/disable 往返）。
