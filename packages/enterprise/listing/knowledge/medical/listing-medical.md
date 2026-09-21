# 场景库：medical（医学核查 listing）

车道：`enterprise_listing_inspect → read_document → run_code → publish(scenario="medical")`。
**与 manual 分库**：需求文本可能相似，但审核对象（医学差异/数据疑问 vs 编程核查）、
输出口径（医学审阅工作簿 vs 核查 listing）不同——禁止互相代理口径。

## L1 写码前门禁（Gate）

- **GM0 继承 G0 通用**（值域核对/零命中即停/空表防御/单文件交付/中性代称——
  见 manual 库 G0，所有场景恒适用）。
- **GM1 需求定性**：先确认这是医学审核交付（reviewer 面向）而非 DM 编程核查；
  不确定→向用户澄清，禁止猜。
- **GM2 输出契约**：publish 场景固定 medical 的多 sheet 规范（见
  enterprise_listing_publish 契约/EDC 导出模板）；列集与样式以该场景模板为准，
  未沉淀前先跑 inspect 对齐结构。

## L2/L3（待首个项目收官沉淀——按沉淀模板补）

成熟口径、方法论、坑：**暂无**。首个 medical 项目收尾时按 router.md 沉淀闭环
落库（postmortem→Gate/口径/坑三处→eval）。在此之前遇到的具体问题：逐条向
用户/DM 确认，不代理实现，结论写入 .dsh/kb-capture/ 提案。

## 沉淀模板（首项目收官时填）

- 触发签名细化：/ 输入材料形态：/ 列集与样式契约：/
  口径终案表：/ Gate 清单：/ 坑与信号：/ eval 判据：
