# ADR-0009: 出域单点——执行面全量放开,红线只留行值出域

- 状态:已实施(2026-08-28)
- 日期:2026-08-28
- 负责人:企业插件组
- 影响范围:listing python(sandbox 层/worker 注释)、listing TS(系统提示/工具描述)、本仓库测试
- 取代:ADR-0008 决策 1(GuardedModule 运行时护栏)与修订 1/2/3 的执行面部分(FP-1 枚举写出器、FP-2 注入补偿、FP-3 safe_import 白名单);ADR-0007 决策 6 中"AST 禁用表补双下划线/IO 构造器"部分
- 保留:ADR-0008 决策 2(Excel 公式中和)、决策 3(worker 环境白名单)与修订 4/5(护栏豁免、V-4/6/7/8 闭合);ADR-0007 全部(单规则红线/lane 护栏/单源配置)

## 背景

用户 2026-08-28 终裁(原话):

> "不管在哪一层,都不限制 harness AI 的代码执行面。我们始终限制的是代码
> 读取的数据行 data 出域。本身 AI 通过理解 spec 需求就要通过 ALS 表单
> 字段 OID 去查询对应 SAS 数据、匹配程序代码处理查询/聚合等相关操作,
> 全程代码执行。只要数据不出域发送给 AI 就行。"

listing 的合法工作流本身就是全程代码执行:理解 spec → 按 OID 查询 SAS →
查询/聚合/变换。ADR-0007/0008 逐步加码的执行面限制(read_/to_ 前缀、
import 白名单、子模块封死)与该工作流存在结构性张力——任何"逐属性封堵"
最终都会撞上某个合法需求(FP-1~FP-3 已三次证明),且防线位置错了:
**该把守的是数据出口,不是代码执行**。

## 决策

1. **执行面全量放开**:sandbox 层删除 AST 禁用表、GuardedModule 运行时
   护栏、safe_import import 白名单、builtins 白名单。代码以标准 Python
   执行:标准内建(open/eval/exec/getattr/…)与任意 import(os/sys/
   subprocess/…)可用;pd/np 以裸模块进入命名空间,read_*/to_* 各取所需。
2. **出域单点不变**:唯一恒定红线 = 数据集行值不出域,控制点全部在
   **回执出口**而非执行层:data_guard.sanitize_receipt 投影(inspect/
   run_code 回执只含元数据)、tool-audit 通用车道护栏(挡 generic 工具
   把数据集原文拉进上下文)、worker 回执 120 字符名称上限(V-4)。
   表结构字段(columns/dtypes/rowCount/nullCount/uniqueCount)恒全量可见。
3. **开关语义不变**:数据开关只控制出域控制点(投影+车道护栏);执行面
   不受任何开关触碰(开与关都全量放开)。
4. **保留的非执行面护栏**:Excel 公式中和 literal_cell/hyperlink 转义
   (V-2,交付物安全)、worker spawn 环境白名单(V-3,不向子进程交出宿主
   凭据——不限制代码,只收缩暴露面)、捕获流 1MB 上限+truncated(V-7a,
   健壮性)、back_link =HYPERLINK 白名单(V-8,交付物契约)、
   list_files/scan_excel_structures 便利助手自带项目根围栏(助手契约,
   非执行限制——open/os 可自行处理任意路径)。
5. **提示词口径同步**:系统提示与 run_code 工具描述改写(执行面全开;
   交付纪律=交付走 publish、stdout 勿打印行值——纪律性引导,非硬限制);
   ENVIRONMENT_HINT 重写;worker.py 数据流注释更新。

## 风险登记(用户终裁显式接受)

| # | 风险 | 处置依据 |
|---|---|---|
| R-1 | 无限制执行的宿主破坏面(幻觉性 rm -rf/越项目写文件/任意命令) | 非对抗威胁模型;系统提示纪律;TS 侧 900s 粗粒度兜底;ADR-0008 形态已入库(commit 61dc8a9 基线),可随时 revert |
| R-2 | stdout 打印行值通道 | 既定接受(ADR-0007 决策 5):堵死即变蠢,属内容判定;纪律提示兜底 |
| R-3 | 网络出域(urllib 等)不再封 | 同 R-1 威胁模型;worker 环境白名单已收走凭据,外发无据可用 |

## 不采用的方案

- **stdout 投影/内容脱敏**:内容级判定,违背"源头判定"原则且必误伤
  调试;维持 ADR-0007 既定边界。
- **进程级隔离(seccomp/容器)替代**:属 harness 部署层能力;插件层
  已按终裁收敛为出域单点。
- **"项目根内自由 IO"折中(路径围栏化 read_/to_ 入口)**:仍是执行面
  限制,且需要包装 DataFrame 方法面(重侵入);终裁要求零限制。

## 升级影响

纯 listing 包内变更;lib/ 自动重建;装配与 profile 不动。ADR-0008 的
六条逃逸链回归测试随决策退役(历史在 git);新增执行自由回归测试
(import os/open 读写/pd.read_csv+to_csv roundtrip/eval-exec)。

## 验证

pytest 143 全绿(2026-08-28 实测;160→143:24 条封堵用例退役、7 条自由
用例新增);四包 tsc -b 零错误;出域投影用例零回归(test_data_guard/
test_worker_dispatch 全绿)。Windows 侧以 check:all 收口(见
DEFECT_FIX_PLAN_20260828.md 批 4)。

Windows 收口补充(2026-08-28):check:all 八步全绿(oxlint 仅存量警告),
四包 tsc/Vitest、架构、密钥、Python 依赖、upstream 与 profile 装配均通过;
scripts/start.bat 以 DSH_PORT=3090 实点启动,HTTP 200 且企业品牌标题生效。
doc/ Excel 直通、通用车道 deny/关闭放行、run_code 中文错误与执行自由由
对应 Python/TS 集成测试覆盖。
