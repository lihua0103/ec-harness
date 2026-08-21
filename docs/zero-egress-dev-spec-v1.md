# 临床数据零出域改造 — 统一开发规格书

版本 v1.1 | 2026-08-20 | 状态：待开发
本文档自包含：不依赖任何会话上下文，可直接交给开发 agent / 开发者按序执行。

---

## 0. 背景：审计结论与缺陷清单

仓库：dsh-guard（Node 插件 `dsh-clinical-data-guard/src/*.js` + Python 安全 worker
`dsh-clinical-data-guard/security/*.py`，经 `.dsh/profiles/clinical` 以
`link:../../../dsh-clinical-data-guard` 软链安装 —— 源码即运行时，改完重启 DSH 即生效）。

2026-08-20 codebase-auditor 全量审计 Verdict=FAIL，已实测确认的缺陷：

| 编号 | 缺陷 | 证据 | 优先级 |
|---|---|---|---|
| D1 | `security/smart_guard.py`（439行，白名单统一token化架构）**完全未接线**：仅 tests/unit/test_smart_guard.py 引用；worker.py / index.js / tool-result-guard.js 零引用；不在 package.json `files` 发布清单 | grep 全仓 + 实测 `smart_scrub_text` 对新形态数据正确 token 化而三条生产车道全放行 | P0 |
| D2 | 生产车道是黑名单正则，新形态默认放行（fail-open）：`Pt#4521`、点分日期 `2026.08.19`、中文患者行实测 PASSED-THROUGH | egress_checkpoint.check / StreamingScrubber.scrub_row / patterns.js scanDlp 三车道复现 | P1 |
| D3 | **会话锁死**（用户 2026-08-20 报告：连接后发任何消息全被拦）。审计日志 `var/egress_audit/egress_202608.jsonl` 当天 1018 次 BLOCK。机制 = 两个叠加缺陷：<br>(a) 单个日常词触发拦截 —— 最小被拦载荷 38 字节，命中 `CDISC字段:visit`，即对话里写 "visit 3 / subject 12" 就拦；<br>(b) llm/stream 全量历史重扫无自愈 —— 历史中一条命中内容（含误报）导致此后每条新消息重复命中同一处历史，143B 同一载荷当天被反复拦数十次。BLOCK 只抛异常不改写历史，永不自愈 | 审计日志统计：字母前缀编号602 / 复合威胁CDISC+ID 436 / CDISC字段:subject 401 | P0-紧急 |
| D4 | 双车道口径不对称：post-execute 只 token 化"认得出"的值，llm/stream 只会 BLOCK。漏 token 化的值进历史 → 出域侧钉死 | data_egress_guard.py:377-388 vs egress_checkpoint.py 二值动作 | P2（随D1消解） |
| D5 | git master 零 commit，5000+ 行安全代码无版本控制 | `git log` 报无 commit | P2 |
| D6 | 测试环境漂移：requirements.txt 声明 xlwt 但环境可能未装，2 用例静默失败混入基线 | run_all.py 实测 | P3 |
| D7 | 接线 smart_guard 后 `llm/stream` 直接修改 `options` 属性触发 `Cannot assign to read only property 'provider'`。根因：DSH 传入 stream 中间件的 options 对象部分字段（provider 等）是只读的；`modelRequestPayload(options)` 生成的 payload 包含 provider，回写时即使值相同也会抛 TypeError | 用户实测截图：本轮运行失败 Cannot assign to read only property 'provider' of object '#<Object>' | P0-紧急 |

**架构判断（本方案根基）**：不再新增任何"识别临床数据"的正则。安全性来自双层构造性隔离：
- 第一层（主防线）：AI 只见 demo 替身数据 —— 真实数据在 AI 可达范围内不存在；
- 第二层（兜底防线）：smart_guard 接线 —— 凡出域内容，证明不了安全就统一 HMAC token 化。

参考标准：OWASP LLM02 (Sensitive Information Disclosure，建议 sanitization/tokenization
而非仅检测拦截)；NIST SP 800-188 (De-Identifying Datasets，synthetic data 共享模型)。

---

## 1. 目标不变量（最终验收即验这四条）

| # | 需求原文 | 系统不变量 |
|---|---|---|
| I1 | sas数据集/data数据不允许读取发送给AI | AI 上下文永不出现 realDataRoot 下任何文件的单元格原值 |
| I2 | spec/als/template 允许读取全部数据来理解需求 | 该类内容走 `profile='spec'` 车道，散文/结构词零改写 |
| I3 | report辅助数据集允许读表头结构字段（多表头/不规则/横/纵） | 走既有 EXCEL_HEADERS_ONLY 车道，数据行不出域 |
| I4 | 不管什么场景，误操作读取的数据统一拦截 hash 化后再发给AI | 白名单式：证明不了安全一律 token 化；BLOCK 仅剩 mass-dump（≥200数据行）一条红线 |

---

## 2. 紧急止血（先于一切开发，5分钟）

D3 锁死使系统当前不可用。编辑 `.dsh\profiles\clinical\cordis.patch.yml`
（当前是空数组 `[]`），改为：

```yaml
- config:
    id: clinical-data-guard
    mode: shadow
```

重启 DSH。shadow 下 worker 返回 `observed` 不拦截、照常写审计（日志已有 53 条
OBSERVED 证明通路可用）。

- 注意：插件 bundle 的 `cordis.patch.yml`（dsh-clinical-data-guard/ 下那份）写死了
  `mode: enforce`，且 `validateConfig` 的优先级是 `raw.mode ?? env`，**设环境变量
  DATA_PROTECTION_MODE 无效**，必须在 profile 补丁层覆盖 config。
- shadow 是临时止血：期间出域防护只审计不拦截，勿处理真实临床数据。
- 阶段1 验收通过后把此补丁删除（回到 enforce），锁死问题永久消失。

---

## 3. 阶段 0：基线固化（0.5h，不做不许动代码）

```bash
cd <dsh-guard 根目录>
git add -A
git commit -m "baseline: pre-refactor snapshot 2026-08-20"
git checkout -b feat/zero-egress-architecture
pip install -r requirements.txt        # openpyxl/xlrd/xlwt/pyreadstat，消掉环境失败用例
python dsh-clinical-data-guard/tests/run_all.py
```

**退出条件**：`TOTAL_FAILED_SUITES=0`；有 commit 可回滚。

---

## 4. 阶段 1：接线 smart_guard —— 统一 token 化兜底（1天，P0）

### 必读：阶段 1 同时修复 D3（会话锁死）和 D7（只读 options 抛错）

D3 与 D7 都是 smart_guard 接线过程中的真实缺陷：D3 源于 v1 车道"BLOCK 不改写历史"导致全量历史重扫钉死会话；D7 源于 v1 改写到 v2 时直接修改 DSH 传入的只读 options 对象。两者都必须在阶段 1 验收用例中覆盖。

### 4.1 现有资产（已实现、已测，直接用）

`security/smart_guard.py` 公开 API（勿改语义，只接线）：

```python
smart_scrub_text(text: str, profile: str = 'strict') -> tuple[str, ScrubStats]
smart_scrub_structure(payload: Any, profile='strict') -> tuple[Any, ScrubStats]
is_mass_data_dump(stats: ScrubStats, threshold=200) -> bool
# ScrubStats: lines_total / lines_changed / data_lines / tokens_hashed
```

保证（模块自带）：幂等（token 产物重扫不变）；操作性路径原样保留；spec profile
下散文/文档编号（DVP20260610、DS5565-0002-NIS-MA 型）零改写；数据行字母值连坐
token 化；HMAC 会话密钥仅 worker 内存。

### 4.2 任务 1-A：worker.py 替换 scrub_text / scrub_row 分支

文件：`security/worker.py`（scrub_text 分支约 195 行处，scrub_row 约 175 行处）。
现实现走 StreamingScrubber（黑名单），替换为：

```python
if operation == "scrub_text":
    from security.smart_guard import smart_scrub_text, is_mass_data_dump
    text = str(request.get("text", ""))
    profile = str(request.get("profile", "strict"))   # 'spec' 由调用方声明
    scrubbed, stats = smart_scrub_text(text, profile)
    return _result(
        True,
        text=scrubbed,
        scrubbed_rows=stats.lines_changed,      # 保留字段名，Node 侧契约不破
        data_lines=stats.data_lines,
        tokens_hashed=stats.tokens_hashed,
        needs_user=is_mass_data_dump(stats),    # 唯一 BLOCK 红线
        user_prompt=(
            f"数据安全检查：检测到 {stats.data_lines} 行大规模数据转储。"
            "选项：跳过（默认）/ token化后继续 / 允许（需授权）"
            if is_mass_data_dump(stats) else None
        ),
    )
```

scrub_row 分支同理收敛：对 `" ".join(row)` 调 smart_scrub_text，risk_level 由
`data_lines>0` 映射为 SUSPICIOUS_LOW（保持响应字段形状，勿破坏消费契约）。

Node 侧消费点（`src/tool-result-guard.js` :164-175 与 :212-225）字段名
`scrub.text / scrub.scrubbed_rows / scrub.needs_user / scrub.user_prompt` 不变，
**无需改动**。

### 4.3 任务 1-B：egress_checkpoint.py 新增 check_egress_v2

文件末尾追加（旧 `check_egress` 保留为回滚路径，勿删）：

```python
def check_egress_v2(payload: Any, context: Dict[str, Any] = None) -> Dict[str, Any]:
    """白名单式出域检查：token 化替代 BLOCK，仅 mass-dump 一条红线。
    v1: 认出危险才拦（漏认=泄露，误认=钉死会话）；
    v2: 证明不了安全就 hash（漏认/误认代价同为多 hash 一个值）。
    审计复用 EgressCheckpoint 的落盘与指纹机制，口径不变。"""
    from security.smart_guard import smart_scrub_structure, is_mass_data_dump
    checkpoint = get_egress_checkpoint()
    scrubbed, stats = smart_scrub_structure(payload)
    threats = []
    if stats.tokens_hashed:
        threats.append(EgressThreat(
            threat_type="raw_value_in_history", confidence=1.0,
            evidence=f"{stats.tokens_hashed} 值已 token 化 / {stats.data_lines} 数据行",
            location="payload", pattern_name="smart_guard", recommendation="SCRUB"))
    mass_dump = is_mass_data_dump(stats)
    if mass_dump:
        threats.append(EgressThreat(
            threat_type="mass_dump", confidence=1.0,
            evidence=f"{stats.data_lines} 数据行", location="payload",
            pattern_name="体量红线", recommendation="BLOCK"))
    try:
        evidence = checkpoint._request_evidence(payload)
    except Exception as exc:
        evidence = {"fingerprint_error": type(exc).__name__}
    audit_id = checkpoint._log_audit(
        threats, [t for t in threats if t.recommendation == "BLOCK"],
        context, evidence)
    mode = str((context or {}).get("mode", "enforce")).lower()
    if mass_dump and mode not in ("shadow", "disabled"):
        raise EgressViolation(
            [t for t in threats if t.recommendation == "BLOCK"], audit_id)
    return {"audit_id": audit_id, "payload": scrubbed,
            "tokens_hashed": stats.tokens_hashed, "data_lines": stats.data_lines}
```

worker.py 的 `check_llm` 分支（约 146 行处）：

```python
if operation == "check_llm":
    import os as _os
    v2 = _os.environ.get("EMERALD_EGRESS_V2", "1") != "0"   # 灰度开关，默认开
    try:
        if v2:
            from security.egress_checkpoint import check_egress_v2
            evidence = check_egress_v2(request.get("payload", {}), context)
        else:
            evidence = check_egress(request.get("payload", {}), context)
        return _result(True, action="allow", **evidence)
    except EgressViolation as exc:
        if mode == "shadow":
            return _result(True, action="observed", audit_id=exc.audit_id,
                           threats=len(exc.threats))
        return _result(False, code="EGRESS_VIOLATION", audit_id=exc.audit_id,
                       threats=len(exc.threats))
```

### 4.4 任务 1-C：index.js stream 钩子消费 v2

文件：`src/index.js` stream 钩子（约 466 行起）。关键改变：命中残留原值时
**改写载荷放行**而非抛异常钉死会话：

```js
const check = await runtime.request({
  operation: 'check_llm', payload,
  context: { ...context(config), scanScope: 'full_generate_options' },
});
if (!check.ok) { /* 既有 EGRESS_VIOLATION / consume_authorization 逻辑原样保留，
                    v2 下仅 mass-dump 会走到这里 */ }
if (check.action === 'scrubbed' && check.payload && typeof check.payload === 'object') {
  // DSH 传入 stream 中间件的 options 对象部分字段（provider / model 等）
  // 是只读的（read-only property）。直接 `options[key] = ...` 会抛
  // TypeError: Cannot assign to read only property 'provider' of object '#<Object>'。
  // 必须构造新对象传入 next()；展开操作符会复制 signal 等未 token 化字段，
  // 并用 token 化后的 messages 等覆盖原值。
  yield* next({ ...options, ...check.payload });
  return;
}
yield* next();
```

**验证**：仿 `tests/integration/plugin_driver.js` 的假 ctx 模式写最小集成测试，
构造一个 `Object.freeze` 或含 `Object.defineProperty(obj, 'provider', { value, writable: false })`
的 options，断言 scrubbed 后请求不抛错、next 收到的新对象 messages 已 token 化。
**必须在 Windows 本机验**（沙盒中 `.dsh/profiles/node_modules` 的 pnpm 符号链
接读取会 I/O error，见 §9 环境坑）。

### 4.5 任务 1-D：打包与同步

1. `package.json` `files` 数组加入 `"security/smart_guard.py"`（**当前缺失，
   发布包里没有这个文件** —— D1 的一部分）；
2. `python scripts/sync_patterns.py` 重新生成 `security/node_patterns.json` 与
   Node 端副本；
3. `src/patterns.js` 的 `scanDlp` 保留为工具参数快筛（quickGuard），职责降级为
   "提前拦明显数据转储参数"，不再是防线本体 —— 不改代码，只改 README 定位描述。

### 4.6 阶段 1 验收

新增 `tests/unit/test_smart_guard_wiring.py`（挂进 tests/run_all.py 的 TARGETS）：

| 用例 | 断言 |
|---|---|
| W1 新形态零出域 | `Pt#4521 baseline 2026.08.19 ALT 342` / 中文患者行 / `USUBJID: 101-001-1001` 经 worker scrub_text 与 check_llm(v2) 输出**不含任何原值数字串** |
| W2 spec 零改写 | `Visit Date(D1)`、含 DVP20260610 的需求段、纯英文散文，profile='spec' 输出 == 输入 |
| W3 幂等自愈 | W1 输出再过一遍 scrub_text/check_llm，输出不变、tokens_hashed==0（根治 D3b：历史重扫不再二次命中）|
| W4 锁死场景回归 | 模拟 D3：messages 历史含一条 `subject A1234567` 误报内容 + 新消息 "hello"，v2 下请求**放行**（载荷 token 化），不抛 EGRESS_VIOLATION |
| W7 只读 options 不抛错 | 构造 options 含 read-only `provider`/`model` 字段，触发 scrubbed 后调用 stream 钩子，断言不抛 `Cannot assign to read only property`、next 收到的新对象 messages 已 token 化（修复 D7）|
| W5 体量红线 | 250 行数据文本 needs_user==True；199 行 ==False |
| W6 日常词可用 | 38 字节消息 "check visit 3 for subject" 放行且零改写（根治 D3a）|

存量套件：`python tests/run_all.py` 全绿。个别断言旧 BLOCK 行为的用例改为断言
"token化+SCRUB审计"，属预期迁移，逐条在 commit message 里说明。

**退出条件**：W1-W6 + 存量全绿；`EMERALD_EGRESS_V2=0` 可一键回退 v1；
删除 §2 的 shadow 补丁切回 enforce 后，正常对话（含 subject/visit 字样）不再被拦。

---

## 5. 阶段 2：demo 数据替身车道（3-4天，主防线）

### 5.1 目录约定与数据流

```
<project>/
  data_real/            # 真实数据（备份/真值源）。AI 一切工具：拒绝
  data_demo/            # demo 替身（结构同构、值全合成）。AI：自由读取
  data_demo/manifest.json
  spec/                 # spec/ALS/template：profile='spec' 全量放行
  output/               # listing 产物：本地写，AI 只见 DATA_BLOCKED 占位（现状保留）
```

manifest.json 形状：

```json
{ "version": 1, "generated_at": "...", "datasets": {
    "<数据集名>": { "real_path": "data_real/xx.sas7bdat",
                    "demo_path": "data_demo/xx.csv",
                    "real_format": "sas7bdat", "demo_format": "csv",
                    "sheets": ["..."], "columns_meta": "data_demo/xx.columns.json" } } }
```

工作流：
1. 本地一次性构建：`build_demo_replica` 把 data_real 全量复制为 data_demo
   （AI 不参与、不可见过程）；
2. AI 理解与开发：读 spec（全量）+ demo（全量），写 listing 程序；程序**必须经
   manifest 取数**（取数层按 real_format/demo_format 分派 read_sas/read_csv/
   read_excel），禁止硬编码路径；
3. 本地真实运行：同一程序、manifest 切 real → 处理真实文件产出 listing；
   stdout/报错栈照旧过阶段 1 token 化兜底（闭合"回传通道"）。

### 5.2 任务 2-A：抽共享结构库 security/table_structure.py

从 `excel_header_extractor.py` 抽出已实现的结构检测（重构搬移，非新逻辑）：
`_score_row`（表头行评分）、`_find_header_end_row`（多行/不规则表头边界）、
`_detect_orientation`（横/纵向）、`_extract_merged_info`（合并单元格多级表头）。
`excel_header_extractor.py` 与新的 demo 生成器共同 import，单一来源。
抽完后跑存量测试确认表头提取行为不变。

### 5.3 任务 2-B：security/demo_replica.py（核心新模块）

安全性质（构造性，不依赖识别 —— 这是与旧黑名单的本质区别）：
1. 表头区（table_structure 判定）逐字保留 —— AI 需要真实字段名理解需求（I3）；
2. 数据区每个单元格**无条件合成** —— 不做"是否敏感"判定，没有漏认通道；
3. 判定不确定（表头边界模糊/方向不明）→ 整格合成（fail-closed）；
4. 同值同像：项目级 HMAC 密钥派生，同一真实值全项目映射同一合成值，跨表
   join/主键关联在 demo 上成立（AI 程序逻辑可完整验证）；
5. 保格式形态：日期→日期（按源格式）、N位数字→N位数字、编号→同骨架换值 ——
   多表头/类型推断/解析逻辑在 demo 与真实数据上行为一致。

合成规则 `_synthesize(value, key)`：

| 真实值类型 | 规则 |
|---|---|
| 日期/时间（任意文本格式或 datetime 类型）| 基准 2001-01-01 + (HMAC mod 3650) 天，按源格式输出 |
| 纯数字 | 同位数 HMAC 派生数字（首位非零；保留 int/float/前导零形态）|
| 含数字字符串（编号类）| 保留字母/数字/标点骨架，数字位与字母位由 HMAC 流替换 |
| 自由文本（AE术语/姓名/状态）| `DEMO_<HMAC hex6>`（显式合成标记）|
| 空值 | 保留（缺失模式是程序逻辑的一部分）|

项目级密钥：`var/demo_replica.key`（os.urandom(32)，chmod 0600，本地生成绝不
出域；与 tokenizer 会话密钥分开 —— demo 需要跨会话稳定）。

格式支持：
- xlsx/xls：openpyxl/xlrd 读 → 结构检测 → openpyxl 写 demo.xlsx（合并单元格、
  sheet 名保留）；
- csv/txt：同规则逐行；
- sas7bdat：pyreadstat 读 → demo 落 csv + `columns_meta` JSON（列名/label/类型；
  pyreadstat 不能写 sas7bdat）。manifest 记 real_format=sas7bdat，取数层据此在
  真实运行时自动 read_sas —— 这就是禁止硬编码路径的原因；
- zip：解包 → 逐文件按上表处理 → 重打包 demo.zip；密码 zip 走既有
  credentialsDir 本地凭据通道（原值不进模型上下文）。

**泄漏自检（生成流程内强制，非仅测试）**：

```python
def _leak_check(real_cells: set[str], demo_root: Path) -> None:
    """demo 产物中不得出现任何长度≥4的真实数据区单元格原值（字节级扫描，
    表头值除外——表头本来就允许出域）。失败 = 生成器有 bug：删除全部产物并抛错。"""
```

### 5.4 任务 2-C：守卫接线（3 处，均为收窄）

1. `security/ai_operations_monitor.py` `check_local_data_policy`（约 236 行）：
   新增 demo 车道分支 —— context 含 `demoDataLane=='enabled'` 时：
   - 路径解析后绝对前缀落在 realDataRoot 内 → 一切通用工具（bash/read/pwsh/
     glob内容读）BLOCK + 审计。判据复用 `resolve_local_data_path` 同款
     `Path.resolve` + `_inside` 前缀判断（防 `../` 穿越），**不是**文件名黑名单；
   - 落在 demoDataRoot 内 → 放行；
2. `src/tool-result-guard.js` `safeToolResult`：`extractPath` 结果在
   demoDataRoot 内 → 结果直通（合成数据，token 化只损可读性）；在 realDataRoot
   内 → 恒 `DATA_BLOCKED` 占位（双保险，正常已被 pre-execute 拒）。路径判断复用
   `isCredentialPath` 同款 resolve/relative 判据；
3. `src/index.js` `validateConfig`：新增 `demoDataLane: 'disabled'|'enabled'`
   （默认 disabled）、`realDataRoot`、`demoDataRoot`；enabled 时两 root 必填、
   均须存在、且不得互相包含（resolve 后前缀互查）。`context()` 函数将三个字段
   注入 worker context。

### 5.5 任务 2-D：构建入口

- worker.py 新增 `build_demo_replica` 操作：入参 real_root/demo_root（须与
  config 一致，worker 内二次校验路径边界）；返回**仅统计摘要**
  `{files, sheets, rows, leak_check: "passed"}`，零数据值；
- index.js 仿 `registerLocalMetadataTool` 的写法注册 `build_demo_replica` 工具
  （defineTool + output schema 锁死字段 additionalProperties:false），AI 可发起
  构建但只见摘要；
- 命令行入口：`python -m security.demo_replica <real_root> <demo_root>` 供人工执行。

### 5.6 阶段 2 验收

新增 `tests/unit/test_demo_replica.py` + `tests/e2e/test_demo_lane.py`：

| 用例 | 断言 |
|---|---|
| R1 零残留 | 夹具（多行表头/合并单元格/纵向表/csv/伪sas）构建 demo，字节级扫描：任何≥4字符真实数据区原值不在产物任何文件中 |
| R2 确定性 | 同输入两次构建产物逐字节一致 |
| R3 join 保持 | 同一真实值跨两表 → demo 中同一合成值，pandas merge 行数与真实数据 merge 一致 |
| R4 结构等价 | demo 与真实文件：sheet数/列名/行数/合并单元格/dtype 推断一致 |
| R5 守卫-拒 | demoDataLane=enabled 下 bash `cat data_real/x.csv`、read data_real/y.xlsx 全部 BLOCK 且有审计记录 |
| R6 守卫-通 | read data_demo/* 直通，内容为合成值 |
| R7 端到端 | 夹具项目：spec+demo → 最小 listing 程序 → manifest 切 real 本地跑 → 产出与预期一致（证明 demo 开发 ↔ real 运行等价）|
| R8 fail-closed | 构造表头边界模糊夹具 → 疑似表头行被整体合成（宁可多合成不漏）|

**退出条件**：R1-R8 + 存量 + 阶段1 用例全绿。

---

## 6. 阶段 3：灰度上线与回归（1天）

1. shadow 跑真实项目 1 天：核对审计 `tokens_hashed/data_lines` 分布；确认 spec
   车道零误伤（I2）——审计里 spec 类会话 tokens_hashed 应为 0；
2. 删除 §2 shadow 补丁 → enforce + `demoDataLane=enabled`；
3. 锁死场景实地回归：在真实 DSH 会话里复现 D3（历史含误报 + 连发消息），断言
   行为是 token 化放行而非拦死；
4. 提交：阶段 0/1/2 各一笔 commit，tag `zero-egress-v1`。

---

## 7. 最终验收矩阵

| 场景 | 期望 | 不变量 |
|---|---|---|
| AI 读 data_real/*.sas7bdat（任意工具）| 拒绝 + 审计 | I1 |
| AI 读 data_demo/*（任意工具）| 直通，内容为合成值 | I1 |
| AI 读 spec/ALS/template 全文 | 零改写放行 | I2 |
| AI 读 report 辅助数据集 | 表头/结构/字段出域，数据行不出 | I3 |
| 误读任意未知形态数据（新编号/新日期/中文行）| 统一 token 化放行，不 BLOCK | I4 |
| 本地程序跑真实数据报错栈含单元格值 | post-execute token 化 | I4 |
| 单载荷 ≥200 数据行 | 用户决策（跳过/token化/授权）| 体量红线 |
| token 产物被历史重扫 | 幂等不变，会话不钉死 | 自愈（根治 D3）|
| options 含只读 provider/model 字段 | stream 不抛 TypeError，正常放行 | D7 修复 |
| 对话含 subject/visit 等日常词 | 零改写放行 | 可用性（根治 D3a）|
| demo 构建完成 | 字节级零残留自检通过 | 泄漏自检 |

---

## 8. 残余风险（明示接受，写进 README）

1. 用户亲手粘贴少量真实数据进对话框：数据所有者主动行为；token 化尽力覆盖。
   若 §4.4 降级路径生效，此项为唯一原值出域通道；
2. 散文中 ≤2 位小编号（Day 3 / v2 / 3.2）放行 —— spec 可读性需要，孤立两位数
   不构成可识别患者数据（smart_guard 模块头注释已明示）；
3. demo 只保形态不保统计分布 —— 依赖分布特征的程序逻辑需在真实运行阶段验证，
   这是 manifest 双跑设计存在的原因；
4. 依赖 CVE 未审计：独立事项 `npm audit --prefix runtime` + `pip-audit`，不阻塞。

---

## 9. 环境坑与工程纪律（实测记录，务必读）

1. **Linux 沙盒读 `.dsh/profiles/node_modules` 的 pnpm 符号链接会 I/O error /
   超时** —— §4.4 的 next() 契约验证、任何涉及已安装依赖的操作在 Windows 本机做；
2. `validateConfig` 优先级 `raw.mode ?? env`：bundle 已写死 mode，**改行为必须
   动 profile 的 cordis.patch.yml，环境变量无效**；
3. 插件是 `link:` 软链安装：改源码重启 DSH 即生效，无需重新打包；但发布 tgz 时
   `files` 清单决定内容物（D1 教训：smart_guard.py 曾不在清单）；
4. worker 协议：每行一个 JSON 请求/响应，任何异常必须转 fail-closed 响应，
   绝不让异常杀死服务循环（worker.py `_emit`/main 已有范式，新分支照抄）；
5. 大文件编辑：本仓涉及 `*.py` 长文件时用 bash + `python -m py_compile` 校验，
   Edit 类工具有截断前科；改完删 `__pycache__` 防 stale pyc；
6. 测试跑法：`python tests/run_all.py`（runpy 驱动，非 pytest）；新测试文件挂进
   TARGETS 列表才会被执行；
7. 临床数据合规红线：一切调试/诊断只回传汇总数字，绝不回传样本值/患者级数据 ——
   包括测试夹具也一律用构造的假数据；
8. 每完成一个任务一笔 commit，commit message 引用本文档任务号（如 `1-A`）。

---

## 10. 工作量与依赖关系

| 阶段 | 内容 | 工作量 | 阻塞 |
|---|---|---|---|
| §2 | shadow 止血 | 5 分钟 | 立即，独立 |
| 0 | git 基线 + 环境 | 0.5h | 一切开发之前 |
| 1 | smart_guard 接线（1-A→1-B→1-C→1-D→验收）| 1 天 | 阶段 2 的兜底前提 |
| 2 | demo 替身（2-A→2-B→2-C→2-D→验收）| 3-4 天 | 依赖阶段 1 |
| 3 | 灰度 + 回归 + tag | 1 天 | 最后 |

严格按序执行。阶段 1 完成即可解除 shadow 恢复 enforce（锁死根治）；阶段 2 完成
即达成 I1-I4 全部不变量。
