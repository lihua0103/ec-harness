# Emerald Clinical Data Guard 缺陷报告（全仓静态审计 + E2E 实测合并）

**报告日期**: 2026-08-19
**审计范围**: `G:\home\dsh-guard` 全仓（Python 安全内核、JS 插件层、部署链路、文档、测试）+ Web 工作台（http://127.0.0.1:3080）CGB3002-TEST listing 场景 E2E 实测
**红线基线**: 临床数据绝不出域（零容忍）；审计/运行数据不出项目目录
**方法**: 逐行静态精读（三路并行）+ 关键发现人工复核 + 实测哈希比对 + 测试套件实跑 + 浏览器自动化实测（Chrome DevTools MCP）+ worker A/B 对照复现

---

## 0. 综合判定

**Verdict: BLOCKED — 不可发布。**

- E2E 实测发现 **2 个 P0 级全线停摆缺陷**（中文会话 100% 崩溃、maxTokens 超供应商上限），工作台在修复前无法完成任何一轮对话。
- 静态审计发现 **7+ 个 P1 红线绕过/失效路径**（小写绕过、授权竞态、授权不绑定内容等）。
- 文档与发布物存在 **P0 级交付指引错误**（README 指向含已知漏洞的旧包）。
- 本轮已临时修复 2 个 P0（见 §4），修复后测试 37/37 全绿，但 P1 红线项尚未处理。

**缺陷汇总**：

| 级别 | E2E 实测 | 静态审计 | 合计 |
|---|---|---|---|
| P0 | 4（2 已临时修复） | 2 | 6 |
| P1 | 2 | 9 | 11 |
| P2 | 3 | 15 | 18 |
| P3 | 1 | 13 | 14 |

---

## 1. E2E 实测缺陷（2026-08-19 浏览器自动化 + 进程级复现）

### E2E-1【P0｜已临时修复】zh-CN Windows 下 worker 按 GBK 解码 stdin，中文会话 100% 崩溃且检测静默失明

**位置**: [worker.py main()](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/worker.py)（修复前无 stdio 编码强制）；诱因：`start.ps1` 未设置 `PYTHONIOENCODING`

**现象**: 工作台新建会话发送任何含中文的消息，固定报：
```
本轮运行失败：'utf-8' codec can't encode character '\udcae' in position 72: surrogates not allowed (UNKNOWN)
```
1 轮 1 步即失败，LLM 请求从未发出。用户 20 分钟前的历史会话与全新会话表现完全一致（确定性复现）。

**复现步骤**:
1. zh-CN Windows（系统区域 cp936）上按 `start.ps1` 启动工作台（不设置 PYTHONIOENCODING）。
2. 新建会话，输入任意中文（如"读取CGB3002-TEST项目目录相关需求文档..."）。
3. 发送 → 1 步内失败。

**根因**（进程级 A/B 对照实锤）:
- Node 插件向 worker stdin 写 UTF-8 JSON；worker 的 `sys.stdin` 在 zh-CN Windows 默认 **cp936** 解码 → 中文变乱码（"读取"→"璇诲彇"），非法 GBK 字节经 surrogateescape 变孤立代理（`\udcae`）。
- `EgressCheckpoint._request_evidence` 对 canonical JSON `.encode("utf-8")` 遇孤立代理抛 UnicodeEncodeError → 非 EgressViolation → 回 `SECURITY_UNAVAILABLE` → fail-closed 阻断。
- A/B 验证：无 PYTHONIOENCODING 必现；设置后正常。临时打桩抓取的真实 payload 证实乱码在 worker 入口产生。
- **衍生红线问题**: 乱码意味着即使不崩溃，**中文临床数据检测是在乱码上运行的——中文敏感词检测在生产环境整体静默失效**（测试全部设置 PYTHONIOENCODING=utf-8，掩盖了生产环境差异，属"测试环境与生产环境不一致"典型）。

**二次伤害**: 会话一旦被污染消息进入历史，后续所有请求（包括 "ping"）都在同一位置失败——**无恢复路径，整会话报废**。

**修复（本轮已实施）**:
- worker.py `main()` 开头强制 `sys.stdin/stdout.reconfigure(encoding="utf-8", errors="replace")`；
- excel_header_extractor.py `main()` 同步强制 stdout/stderr UTF-8；
- index.js / tool-result-guard.js 两个 spawn 点注入 `PYTHONIOENCODING=utf-8`、`PYTHONUTF8=1` 兜底。
- 修复后：无 PYTHONIOENCODING 环境下干净中文请求 ALLOW + 审计落盘；含受试者号请求正确 EGRESS_VIOLATION。测试套件 37/37 全绿。

**遗留**: 需补"不设 PYTHONIOENCODING 的 worker 中文请求"回归用例；`start.ps1` 建议同步设置 `$env:PYTHONIOENCODING`。

---

### E2E-2【P0】出域指纹计算崩溃发生在审计落盘之前——被拦请求零审计记录

**位置**: [egress_checkpoint.py check()](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/egress_checkpoint.py#L430-L431)

**问题**: `request_evidence = self._request_evidence(payload)`（L430）在 `_log_audit(...)`（L431）之前。E2E-1 的崩溃恰发生在 L430，导致**每一次因崩溃被拦的请求都没有任何审计记录**——实测 14:03/14:19 两次失败在 `egress_202608.jsonl` 中无任何对应条目。

**为何红线相关**: 审计完整性是合规底线。"因异常被拦截的请求"恰恰是最需要留痕的一类，当前实现使其完全无痕。修复方向：审计落盘必须用 try/finally 保证，指纹计算失败时以 `fingerprint_error` 占位记录。

---

### E2E-3【P0｜已临时修复】maxTokens=256000 超 GLM 供应商上限，首轮请求被 INVALID_REQUEST 拒绝

**位置**: `.dsh/settings.yaml` GLM-5.3 模型条目（缺 `maxTokens`/`contextWindow` 声明）+ DSH 默认推导

**现象**: E2E-1 修复后，请求到达供应商即失败：`max_tokens参数非法：限制数值范围[1,131072] (INVALID_REQUEST)`。DSH 按默认 1M 上下文推导 maxTokens=256000，而智谱 coding API 上限 131072。

**复现步骤**: 修复 E2E-1 后发送任意消息 → 轮内失败。

**修复（本轮已实施）**: settings.yaml 为 GLM-5.3 补 `contextWindow: 200000`、`maxTokens: 131072`，无需重启即生效。

**教训**: 两个 P0 叠加导致"工作台从未真正跑通过一轮对话"——冒烟验收（真实供应商端到端 1 轮对话）必须纳入发布门禁。

---

### E2E-4【P1】受试者编号模式误伤消息元数据 UUID/ID 字段，正常对话被"出域阻断"

**位置**: [patterns.py:24](file:///g:/home/dsh-guard/dsh-clinical-data-guard/security/patterns.py#L24) `\b\d{3,4}-\d{3,6}\b`（站点-受试者编号）+ 扫描器不区分内容字段与元数据字段

**实测证据**: 14:31:21 审计记录 `20260819_143121-836e898ca0`：威胁 `subject_id/站点-受试者编号`，location = **`payload.messages[7].id`**（消息 ID 字段，非内容），整个轮次被 BLOCKED，对话中断。

**问题**:
1. `\d{3,4}-\d{3,6}` 形态过于宽泛（电话号段、日期片段、工具 call id 均可命中）；
2. 扫描器对 `id`、`rpcId` 等系统元数据字段跑 DLP 内容模式——元数据不可能含临床数据，属扫描域错误；
3. 误报无申诉/重试通道，用户只能看着对话死掉（加剧 §审计-F-4 的"告警疲劳→人为降级"链条）。

**修复方向**: 扫描字段白名单化（仅 content/text 类字段承载内容检测）；该模式建议要求站点前缀上下文或降级为 WARN 参与组合判定，不独立 BLOCK。

---

### E2E-5【P2｜DSH 上游】pwsh/glob 工具输出契约错误

**现象**（同轮内连续出现）:
- `Pwsh Error: tool "pwsh" returned invalid output: "value" must match exactly one oneOf branch (matched 0)`
- `Glob Error: tool "glob" returned invalid output: "value" must be an object`

**判定**: DSH 0.1.0-rc.6 核心工具（pwsh/glob）返回值与其声明的 JSON Schema 不符，工具调用直接失败。属上游缺陷（runtime/node_modules 内，本项目纪律为不改 DSH 源码），建议：记录上游 issue；工作台侧考虑对工具 schema 校验失败做降级重试或用户可见的明确提示。

---

### E2E-6【P2】UI/流程可用性观察

- **失败无自助恢复**: 轮次失败后无"重试"按钮，错误文案为原始 codec 异常（E2E-1 时期），对非技术用户不可读。
- **品牌改写不一致（实锤）**: 轨迹页同一 CONTEXT 记录，行标签显示原文 "DSH file policy"，展开文本被改写为 "Emerald file policy"——替换只覆盖了部分渲染路径；且证实 branding 会改写**业务文本内容**（此处是系统提示词，若出现在临床数据中即展示失真）。
- **测试污染生产审计目录（实锤）**: `C:\Users\Administrator\.dsh-guard\var\egress_audit\egress_202608.jsonl` 中含 13:56 批次 unit 测试合成 payload 记录（payload_bytes 41-62、session_id=null）——测试与生产审计未隔离。
- **会话标题服务依赖 LLM**: 首轮失败期间标题走 fallback（用户消息截断），恢复后正常，非缺陷但记录在案。

---

### E2E-7【P3】流程中断点记录（供后续续跑）

本轮 E2E 推进到的最远距离：模型开始思考并调用工具（`pwsh`、`Glob`）读取项目目录，尚未完成 spec/als 识别与 listing 数据集生成。**listing 生成主流程的完整观察被 E2E-4 误报阻断打断**，待 E2E-4 修复后需续跑验证。

---

## 2. 静态审计缺陷（红线优先）

### 2.1 P0（发布阻塞）

| ID | 标题 | 位置 | 状态 |
|---|---|---|---|
| ST-P0-1 | **README 指引分发修复前旧包**：`var/…1.0.4.tgz`（SHA-256 `60F7A72F…`）与插件根目录同名包（`4E447556…`）哈希分叉，文档记录的是旧包；按 README 交付 = 交付含已知 P1 漏洞版本 | README.md L40-44 | 待修复 |
| ST-P0-2 | **授权重放/越权消费零防护**：授权用插件级 config 身份而非 `exec.agent` 身份、不绑定被批准的具体内容；一次"允许并审计"= 放行任意一条后续 dirty 请求（现有测试恰好证明）；跨会话重放、并发双消费无测试 | index.js L249-256/L366-372, egress_authz.py | 待修复 |

### 2.2 P1（红线可绕过/关键保证失效）

| ID | 标题 | 位置 |
|---|---|---|
| ST-P1-1 | **大小写绕过**：受试者/SAS日期/医学编码全套模式无 IGNORECASE；`a1234567`、`01jan2024` 穿过三层（检测层不认小写但脱敏层认——自相矛盾） | patterns.py L22-60, node_patterns.json, data_egress_guard.py L319-334 |
| ST-P1-2 | **不可见字符切断**：归一化仅剥 5 个零宽码点；U+FEFF/00AD/180E/bidi 控制符可切断任意模式；缺 NFKC | egress_checkpoint.py L150-154 |
| ST-P1-3 | **授权一次性消费 TOCTOU**：consume/authorize 读-改-写无文件锁（audit_log 有锁，这里没有），并发可双消费 | egress_authz.py L107-131 |
| ST-P1-4 | **匿名身份坍缩**：user/session 为 None/空时全部哈希到同一 "anonymous" 桶，授权跨会话共享 | patterns.py L160-162, egress_authz.py L40-46 |
| ST-P1-5 | **出境拦截开关判定反向**：`mode == "enforce" else []`——任何非精确值静默放行（Node 层 validateConfig 当前兜住，库自身纵深反了） | egress_checkpoint.py L422-427 |
| ST-P1-6 | **quickGuard 安全词豁免前缀注入**：豁免判断作用于整段命中串含值部分，`USUBJID=SCREENING-01-123456` 被豁免 | patterns.js L13-27 |
| ST-P1-7 | **审计 location 写键名原文**：不匹配模式的键名（如"受试者张三的访视"）原样进审计 JSONL 与异常串——审计文件成数据副本 | egress_checkpoint.py L136-141/L482-499 |
| ST-P1-8 | **AI 代码检查双绕过**：`__import__('pickle').load` 同时绕正则与 AST；eval/exec/getattr/marshal/shelve/subprocess 不在视野；bash `c''at` 引号拼接绕 `\b` 锚定 | ai_operations_monitor.py L86-89/L132-138/L438-453 |
| ST-P1-9 | **Excel 表头提取器数据区外泄通道**：启发式打分可把无表头数据表的首行当表头**原值输出**（数值编号<6 位、中文 AE 文本、人名不在模式库） | excel_header_extractor.py _score_row/_dlp_scan_cell |

### 2.3 P2（摘关键项，全量见各分项审计记录）

| ID | 标题 |
|---|---|
| ST-P2-1 | Base64 覆盖不足：<24 字符不解码、不支持 base64url（`-_`）、换行分块不拼合 |
| ST-P2-2 | 日期格式缺口：`YYYY/MM/DD`、`YYYY.MM.DD`、`DD-MM-YYYY` 全线缺失（SAS/EDC 常见） |
| ST-P2-3 | worker/extractor 继承全部宿主 env（含 LLM API Key），又解析不可信 Excel——解析层漏洞=密钥收割；应 env 白名单 |
| ST-P2-4 | `DSH_TELEMETRY_MODE` 尊重外部预设而非强制 DISABLED |
| ST-P2-5 | 安装链路出域：npm/pnpm/pip 首装连公网 registry、pnpm 全局安装无锁、requirements.txt 无 `--require-hashes` |
| ST-P2-6 | Windows 路径分隔符绕过：黑名单只认 `/`，`docment\data\ae.xlsx` 全规则失效 |
| ST-P2-7 | 未知工具默认 ALLOW，防护面依赖名单完整性且无同步机制 |
| ST-P2-8 | 授权文件无 HMAC/无 TTL/root 由请求方任意指定 |
| ST-P2-9 | branding 全局改写 `\bDSH\b`——临床文本中合法 "DSH" 缩写（方案偏离代码/文献引用）被静默改写，GCP 稽查保真性缺陷 |
| ST-P2-10 | stop.bat/start.bat 按 `:3080` 子串匹配 taskkill /F，误杀 30800-30809 端口服务 |
| ST-P2-11 | worker stdin 无行长上限（内存 DoS）；pickle 正则 O(n²) 回溯热点 |
| ST-P2-12 | `.xls` 在插件链路不可达：pre-execute inspect_file 用 openpyxl 打开 .xls 必抛 → deny；FR-06-03 功能未交付，TC-15"已实现"仅覆盖绕过插件的 CLI 直调（误导性结论） |
| ST-P2-13 | 审计/授权默认落用户主目录（`~/.dsh-guard/var/`），与主规范 §10.2/README/AR-3.5 三处"禁止落用户主目录"红线直接冲突，FIX-12 单方改口径未走需求变更（E2E 实锤：文件确实在 `C:\Users\Administrator\.dsh-guard\`） |
| ST-P2-14 | `.gitignore` 缺 `*.jsonl`/`.audit.lock`：审计目录一旦被指回仓库内即可能提交临床痕迹 |
| ST-P2-15 | `_sanitize_command` 只遮三类模式，bash 命令中其余临床原文进审计 |

### 2.4 文档/测试体系缺陷

| ID | 级别 | 标题 |
|---|---|---|
| ST-D-1 | P1 | 红线集合口径不一：主规范 R-1~6 vs 详细需求 R-1~10；BY 编号两文档同号不同义 |
| ST-D-2 | P2 | 测试数量/变异名单/配置表全面过期（单元 14→实 31；缺 EMERALD_AUDIT_ROOT 等 4 项配置文档） |
| ST-D-3 | P1 | 测试盲区：授权重放/并发双消费、worker 协议注入（伪造 requestId/乱序/半行 EOF）、llm/stream typed block 内敏感值、shadow/disabled 模式矩阵、L3 用户拒绝路径（`post-sensitive-denied` 死场景，TC-28 实未覆盖）、quickGuard 零触发 |
| ST-D-4 | P2 | 测试结构性弱点：绕过矩阵单函数（一挂全挂）；`audit_rotation_has_disk_cap` 写死 `egress_202608.jsonl`（**2026-09-01 必红**，距今 12 天）；NFR-1 取 min-of-5 无 IPC；NFR-2 "100 请求"实为 5 条×20 |
| ST-D-5 | P2 | 文件名豁免固化泄露通道：`report-A1234567-v2024-08-18.xlsx` 形态被 oracle 测试确认为放行——已声明的设计豁免，需在红线文档显式承认残余风险 |

### 2.5 P3（择要）

单例懒初始化非线程安全；`hash(code)` 应为 stable_hash；递归无深度上限；审计行无 HMAC 链/无 fsync；Windows chmod 0o600 无效依赖 ACL；stable_hash 无盐可字典反查低熵身份；inline 品牌脚本与未来 CSP 冲突；worker stderr 静默吞掉；`!!js` patch 表达式=配置文件即代码执行面；PATH 解析的 python/node 可被前置目录劫持；ExecutionPolicy Bypass 削弱主机基线。

---

## 3. 修复优先级路线图

**第 1 批（立即，发布阻塞）**
1. ✅ E2E-1 worker UTF-8 编码（本轮已修，待补回归用例 + start.ps1 兜底）
2. ✅ E2E-3 GLM maxTokens 配置（本轮已修）
3. E2E-2 审计落盘 try/finally 保证
4. ST-P0-1 重发发布包 + README/checklist 哈希回标 + 删旧包
5. ST-P0-2 授权绑定 exec.agent 身份 + 内容指纹 + 并发锁（合并 ST-P1-3/1-4 一起改）
6. ST-P1-1 全套模式 IGNORECASE + node_patterns.json 同步 + 小写红队用例

**第 2 批（本迭代）**
7. E2E-4 扫描字段白名单 + 站点-受试者模式降独立 BLOCK
8. ST-P1-2 NFKC + 不可见字符扩展
9. ST-P2-13 审计/授权默认目录回项目内（或走需求变更）
10. ST-P2-3 env 白名单；ST-P2-4 遥测强制 DISABLED；ST-P1-5 判定反转
11. ST-P1-7/ST-P2-15 审计字段白名单化
12. E2E-5 记录 DSH 上游 issue 并加降级提示

**第 3 批（计划内）**
13. ST-P1-8 代码检查补 `__import__`/AST Call/eval 形态
14. ST-P1-9 extractor 表头白名单输出策略
15. ST-P2-5 私有 registry + wheelhouse + pip hashes
16. 测试体系补强（ST-D-3/4）+ 文档编号统一（ST-D-1/2）
17. E2E-7 续跑 listing 全流程验证

---

## 4. 本轮已实施的代码变更（待正式回归与发版）

| 文件 | 变更 |
|---|---|
| `security/worker.py` | main() 强制 stdin/stdout UTF-8 reconfigure（E2E-1 主修复） |
| `excel_header_extractor.py` | main() 强制 stdout/stderr UTF-8 reconfigure（E2E-1 同源） |
| `src/index.js` | worker spawn env 注入 PYTHONIOENCODING/PYTHONUTF8 兜底 |
| `src/tool-result-guard.js` | extractor spawn env 同上 |
| `.dsh/settings.yaml` | GLM-5.3 补 contextWindow: 200000 / maxTokens: 131072（E2E-3） |

**验证**: `python tests\run_all.py` → 全 suite 绿（unit 37/37、integration 15/15、resilience 3/3、branding 1/1、contract 1/1、bypass 1/1，TOTAL_FAILED_SUITES=0）。
**注意**: 修复前该套件曾出现 dd_mmm_yyyy 用例失败（35~36/37），修复后连续 3 次 37/37，失败原因未完全归因，建议持续观察是否 flaky。

## 5. 复现命令备查

```powershell
# E2E-1 A/B 复现（去掉 PYTHONIOENCODING 即崩，修复后通过）
python -c "import json,subprocess,os,sys; env=dict(os.environ); env.pop('PYTHONIOENCODING',None); ..."
# 哈希分叉验证
Get-FileHash -Algorithm SHA256 .\dsh-clinical-data-guard\var\emerald-clinical-data-guard-1.0.4.tgz, .\dsh-clinical-data-guard\emerald-clinical-data-guard-1.0.4.tgz
# 审计落点验证（红线冲突）
Get-ChildItem C:\Users\Administrator\.dsh-guard\var\
# 回归
cd dsh-clinical-data-guard; $env:PYTHONIOENCODING='utf-8'; python tests\run_all.py
```
