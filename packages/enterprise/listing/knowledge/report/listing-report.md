# 场景库：report（报表/汇总类交付）

车道：`enterprise_listing_inspect → read_document → run_code → publish(scenario="report")`。

## L1 写码前门禁（Gate）

- **GP0 继承 G0 通用**（见 manual 库 G0）。
- **GP1 汇总口径出处**：任何汇总规则（分母/去重/期间界定）必须锚定需求文件原文；
  原文没写的口径列待确认，禁止按"惯例"补。
- **GP2 输出契约**：publish 场景固定 report 的多 sheet 规范；未沉淀前先 inspect
  对齐结构。

## L2/L3（待首个项目收官沉淀）

暂无成熟口径。首项目按 router.md 沉淀闭环落库；此前问题逐条确认不代理，
结论写 .dsh/kb-capture/ 提案。

## 沉淀模板（首项目收官时填）

- 触发签名细化：/ 报表类型清单：/ 汇总口径终案：/
  Gate 清单：/ 坑与信号：/ eval 判据：
