# ADR-0007:数据集单规则红线、doc/ 零拦截与通用车道护栏

- 状态:已实施(2026-08-28)
- 日期:2026-08-28
- 负责人:企业插件组
- 影响范围:@dsh-enterprise/listing(python 全层 + TS 入口)、@dsh-enterprise/tool-audit(新护栏)、@dsh-enterprise/ui-settings(配置单源)、@dsh-enterprise/branding(B-6 修复随批落地)
- 取代:ADR-0006 决策 1 中的场景②(aux-excel 投影)与决策 3(通用工具面不拦的"零实现"表述);ADR-0005 的红线残留表述一并作废

## 背景

2026-08-28 系统审计(docs/enterprise/PLUGIN_SYSTEM_AUDIT_20260828.md)与实战运行日志同时暴露两个问题:

1. **场景②误伤合法需求(A-2)**:DVP 的 Manual Review sheet 是规格正文,但以 .xlsx 交付、按路径归一化为 aux-excel,单元格值被投影剥除。模型在合规车道内拿不到做活所需信息,被逼"变盲"。
2. **红线是车道级而非系统级(A-1)**:模型随后经 harness 通用 shell(pwsh + 系统 Python,pandas/openpyxl 齐备)直读文件——listing 车道的投影、审计、开关全部旁路。原"通用工具面不拦属执行安全域"的接受边界在"车道挡住合法需求"时不成立:模型会在合法需求驱动下主动绕过。
3. **体验缺陷放大了上述矛盾**:worker stdout 无 UTF-8 环境导致中文错误 GBK 乱码;sandbox builtins 过瘦(无 Exception/dir/repr)导致模型 6 连败试错探环境。

用户裁决(2026-08-28):**doc/ 不做任何处理拦截;别让 harness AI 变蠢,同时防住真实数据泄露。**

## 决策

1. **红线收敛为单规则**:唯一拦截场景 = 数据集(sas7bdat/xpt/csv,含归档解出)原始行值不出域 → 元数据白名单(name/path/columns/rowCount/dtypes/nullCount/uniqueCount)。`data_guard.PROJECTION` 只剩 `dataset` 一项。
2. **doc/ 零拦截**:spec-document 与 aux-excel 标记全部退出投影表,文本与 Excel 单元格值恒全量回执,与开关无关。截断上限只作协议护栏且显式标记 `truncated`(文本 200K 字符 / Excel 20K 单元格,模型可经自身文件工具续读)。`read_spec_files` 的 `build_rows` 参数删除。
3. **通用车道护栏(tool-audit 复活)**:在官方 `tools/pre-execute` waterfall 挂 dataset 护栏——按**路径引用**拒绝参数中出现数据集扩展名文件的工具调用(返回 `{kind:'deny', reason}`),拒绝理由引导模型回 listing 车道;`enterprise_*` 自有工具豁免;开关关闭零拦截;服务未装配/读取异常按开(fail-closed)。这是源头判定(路径出现与否),不做内容模式扫描。
4. **单源配置**:datasetExtensions 以 ui-settings DataSecurityService 为唯一真源,listing worker 与 tool-audit 护栏均按调用读取(免重启);`.data-security.json` 旧键 `auxExcelExtensions` 废除,载入时自动丢弃。
5. **stdout 维持原样**:run_code 的 stdout/stderr 原样回执(2026-08-27/28 既定边界不变)。威胁模型 = 非对抗 AI。
6. **体验修复随批**:spawn 强制 `PYTHONUTF8=1`/`PYTHONIOENCODING=utf-8` + 解释器候选链(DSH_PYTHON → python/python3 / python→py -3,修 P1-4 与 GBK 乱码);sandbox builtins 补异常类与 dir/repr/map/filter 等;失败回执附 `environmentHint`(环境自描述);AST 禁用表补双下划线属性(堵 `pd.__dict__['read_sas']` 绕过)与 numpy/Excel 文件 IO 构造器。
7. **部署参数出代码**:report Cover 行标签(申办方特定文案)经 cordis.patch.yml `reportCoverLabels` 配置下发,代码内只留中性默认。

## 不采用的方案

- **内容模式扫描兜底(PHI/日期/ID 正则)**:字段黑名单易被改名绕过、误伤合法文本,违背"源头判定"原则。维持不采用。
- **恢复 ADR-0006 场景② + spec-excel 白名单**:曾评估 host 侧按文件名 glob 放行"规格 Excel";用户裁决直接整目录零拦截,更简单且无"白名单漏配"风险——doc/ 的风险面由"内容本就是给 AI 看的"这一定性覆盖。
- **post-execute 内容投影 / llm/stream 出域检查**:内容级二次判定,同上不采用。
- **堵死 stdout**:会使调试不可能(变蠢),且属内容判定;维持原样边界并显式记录。
- **shell 工具整体收权**:超出插件层能力(harness 部署配置域),会让通用能力变残;以"窄护栏 + 引导"替代。

## 数据与安全

- 拦截面:listing 三工具回执(dataset 投影,不变)+ 通用工具参数中的数据集路径引用(新增)。
- 显式接受的残余边界:① 参数中不出现数据集文件名的间接读取(先写辅助脚本再执行)不在拦截面内——非对抗威胁模型 + 系统提示纪律兜底;② run_code stdout 可携带 print 的行值(既定边界);③ 通配符形态(`cat *.csv`)不匹配。护栏的正则按"路径状 token + 扩展名结尾"判定,刻意保守。
- 审计:listing 车道维持 `.clinical-listing/audit.jsonl`(无数据值);护栏拒绝经 logger warn 留痕。
- 开关语义:开 = dataset 车道投影 + 通用车道拒绝;关 = 两者全部零拦截。fail-closed 方向不变。

## 升级影响

- 纯企业包内变更,upstream submodule 不动;六道门禁(check:all 8 步)全过为准。
- `data_guard.PROJECTION` 结构变化:下游若依赖 `aux-excel` 键(仅退役 shim redact.py)会看到空元组兼容别名;Windows 侧删除 shim 后无残留依赖。
- profile 装配无变化(4 包 bundles 顺序不变)。

## 验证

- Python:pytest 全量绿(2026-08-28 实测 143 通过,含新增 doc/ 直通、截断标记、sandbox 内建/封堵用例)。
- TS:四包 `tsc -b` 零错误;tool-audit 护栏行为测试(deny/allow/豁免/开关/fail-closed/可卸载)、ui-settings sanitizeConfig 行为测试、branding 校验/注入行/路由测试随批新增。Windows 侧以 `pnpm run check:all` 收口(沙箱无法跑 vitest/oxlint)。
- 端到端复验:Windows 侧 `start.bat` 启动后,① inspect 能看到 doc/ xlsx 单元格值;② shell 读 .sas7bdat 被 deny 且错误信息引导回 listing;③ 关闭开关后 ② 放行;④ run_code 错误回执中文不乱码。
