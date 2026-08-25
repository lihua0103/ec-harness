# DSH Guard 审计与重构计划

**日期：** 2026-08-23
**审计对象：** `G:\home\dsh-guard`（emerald-clinical-data-guard 1.0.7，Node 插件 + Python worker）
**裁决：** FAIL
**唯一死命令：** SAS/衍生 data 的**数据值**不出域；表结构（表名、列名、行数）可出域。除此之外不加代码限制。

---

## 一、我实际跑了什么（证据基线）

| 项 | 结果 |
|---|---|
| `python tests/run_all.py` | `TOTAL_FAILED_SUITES=4`，退出码 1 |
| `tests/unit/test_listing_plan_contract.py` | 37/37 PASS |
| `tests/unit/test_listing_security.py` | 19/19 PASS |
| `tests/unit/test_security.py` | 62/62 PASS |
| `tests/bypass/test_bypass_matrix.py` | BY-1..BY-13 PASS |
| `tests/integration/test_plugin_runtime.py` | **25/29（4 FAIL）** |
| `tests/unit/test_listing_e2e_fixes.py` | **7/8（1 FAIL）** |
| `git log` | 只有一个 commit：`56d8390 baseline: pre-refactor snapshot 2026-08-20` |
| `git status` | 55 文件、+7519/−2322 未提交；`security/worker.py`、`egress_checkpoint.py`、`src/index.js` 均为 `MM` |
| 沙盒依赖 | `pyreadstat`/`pyzipper`/`xlwt` **缺失**（我为跑测试临时装的，不代表你 Windows `.venv`） |

关键结论：**工作区是一个未提交的半成品重构**。仓库只有一个 pre-refactor 快照，全部 7500 行改动悬空。你感受到的"到处是问题"，一部分就是这个半成品状态本身。

---

## 二、根因：不是需求复杂，是三处方向错误

### R1（P0）出域判据仍是"内容像不像数据"，而不是"数据从哪来"

`worker.py:187` 默认走 `check_egress_v2`（`EMERALD_EGRESS_V2` 未设 = 开）。它对**整个 LLM 载荷**无差别跑 `smart_scrub_structure`，不区分这段文本来自 SAS 数据、spec 需求，还是模型自己的推理句子。

实测（我跑的 `plugin_driver.js`）：

```
llm-dirty        : "Subject A1234567"  →  "Subject [SUBJ:ad661c3b]"
llm-system-dirty : system 同样被 token 化
```

四个 integration FAIL 全部是这一条的连锁：

| FAIL 用例 | 断言 | 实际 |
|---|---|---|
| `test_llm_clean_streams_and_dirty_blocks` | `dirty["content"] == "Subject A1234567"` | 变成 `[SUBJ:…]` |
| `test_full_model_request_scope_blocks_and_audits_clean_requests` | `dirty["system"] == "Subject A1234567"` | 同上 |
| `test_spec_and_document_content_is_exempt_from_automatic_redaction` | ordinary 消息保留 `101-001-0001`、`2026-08-19` | 被抹掉 |
| `test_listing_uses_session_cwd_over_configured_root` | `receipt["inspection"]` | `KeyError: 'inspection'` |

前三条的测试注释写得很清楚：**"普通模型语义不做全局 token 化；数据边界由来源域和专用工具负责。"** 这是这套架构自己写下的契约。v2 违反了它。

这就是你说的"脱敏后无法识别 spec 需求"的**确切机制**：spec 里的编号、日期、KRI 阈值被当成患者数据 hash 掉，AI 拿到 `[SUBJ:hex8]` 无法理解需求。

而且这条路径连**豁免机制本身**都盖过去了——`src/index.js` 用 `TRUSTED_DOCUMENT_CONTENT` + 一次性 token 做了掩码/还原（`maskTrustedDocuments`/`restoreTrustedDocuments`），设计上就是让受信 spec 全文绕过脱敏。v2 在这层之外又扫一遍，把豁免设计废掉了。

### R2（P0）两套出域引擎并存，测试打的是没在跑的那一套

- 生产：`check_egress_v2`（默认）
- `tests/unit/test_security.py`（62 用例）、`tests/bypass/test_bypass_matrix.py`、`tests/mutation/oracle.py`：**全部直接调 `check_egress` v1**

我 grep 过，测试里 `EMERALD_EGRESS_V2` 出现次数为 **0**。

所以那 62+13 个绿灯证明的是**回退路径**安全，不是生产路径安全。生产 v2 的行为唯一被断言的地方，恰好就是那 4 个 FAIL。这是"测试全绿 ≠ 业务可用"的升级版：**测试全绿 ≠ 被测代码在跑**。

### R3（P1）数据域拦截混入了大量与死命令无关的限制

你要的是"只拦 data 值出域"。实际 `src/index.js:317-383` 有一层与出域无关的**行为封禁**：

```js
PWSH_DATA_READ_RE      // pwsh 里出现 Get-Content/Import-Csv 就 deny
PWSH_PYTHON_RE         // pwsh 调 python 且含 read_excel/read_csv 就 deny
PIPE_TO_PYTHON_RE      // 任何 `| python` 就 deny
PWSH_OTHER_LANG_RE     // perl/ruby/lua/rscript
PWSH_R_SAS_RE          // Rscript + .sas7bdat
SHELL_INTERPRETER_RE   // uat-local 下 shell 启动任何解释器就 deny
```

这些**不看路径是否在数据域**，纯按命令串形态封。后果：本地写个处理脚本、`| python` 做个转换、跑 Rscript——全部被拦。这是"不是这儿拦截就是那儿拦截"的直接来源。

真正的边界（`planeAdmission` 里那段 `planeOf(path) === 'data'`）已经足够：数据域文件不给通用工具读。**程序在本地读数据是允许的——数据值不进 LLM 载荷才是死命令。** 这两件事被混为一谈了。

`ai_operations_monitor.py`（720 行）同型：`bash` 命令含 `.sas7bdat` 即 HIGH/BLOCK。

---

## 三、缺陷 → 修复点对照表

按修复顺序排（依赖在前）。ID 与下面的重构计划对应。

| ID | 缺陷 | 位置 | 证据 | 修复点 | 量级 |
|---|---|---|---|---|---|
| **D1** | v2 无差别 token 化整个载荷，废掉受信豁免 | `worker.py:187`；`egress_checkpoint.py:830-866` | 4 个 integration FAIL；driver 实测 | 出域扫描只作用于**标记为数据来源**的片段。`check_egress_v2` 增 `provenance` 入参，未标记片段直接放行 | P0 |
| **D2** | 两套引擎，测试打 v1、生产跑 v2 | `worker.py:187` vs 全部测试 | grep `EMERALD_EGRESS_V2` in tests = 0 | 定一套。v1 及 `EMERALD_EGRESS_V2` 开关删除；62+13 个用例改打生产入口 | P0 |
| **D3** | 与死命令无关的行为封禁 | `index.js:317-383`（6 条正则） | 代码本身 | 全删。只保留 `planeOf(path)==='data'` 的路径判定 | P0 |
| **D4** | `bash` 含 `.sas7bdat` 即 BLOCK | `ai_operations_monitor.py` | L92-106 | 降为审计记录，不阻断 | P0 |
| **D5** | `_sweep_stale_transient` 不扫 staging，与自身注释和测试矛盾 | `listing_workflow.py:139-151` | `test_sweep_stale_transient…` FAIL；我单独复现确认 | glob 只覆盖 `output/` 下 `.*-tmp-*`/`.*-backup-*`，漏了 `.clinical-listing/staging/`。补上 | P1 |
| **D6** | `listing_inspect` 收据结构漂移 | `worker.py:240` / plugin | `KeyError: 'inspection'` | 对齐 `worker` 返回键与 `RECEIPT_SCHEMA` | P1 |
| **D7** | 表头白名单把 ALS 列名打成 `COLUMN_n` | `header_detect.py` | 既有文档 U1；ALS 语义归零 | ALS/EDC 词汇（`PreText`/`ItemOrder`/`DatasetName`/`SASLabel`/`FormOID`/`ItemOID`）列入已证明字段名 | P1 |
| **D8** | sheet 名黑名单含 `listing`/`data`/`ae`/`visit`/`数据` | `data_egress_guard.py:219-223` | 《MM Listing要求》整表被跳过 | 删除。plane 判定已足够 | P1 |
| **D9** | HMAC 密钥 `os.urandom(32)` 每进程随机 | `tokenizer.py:26` | worker 重启后同值 token 全变 | 密钥随 session 而非进程；worker 重启保持 | P1 |
| **D10** | `pyreadstat`/`pyzipper`/`xlwt` 在我的环境缺失 | 沙盒 `pip` | 三个 `ModuleNotFoundError` | worker 启动预检已有（`WORKER_REQUIRED_MODULES`），需确认你 `.venv` 实际状态 | P1 |
| **D11** | 55 文件 +7519 行未提交，仓库只有 pre-refactor 快照 | `git status` / `git log` | — | 修完 D1-D6 后提交，建立可回滚基线 | P1 |
| **D12** | v1 专属死代码 | `data_egress_guard.py`（514 行）、`egress_checkpoint` 威胁检测 | D2 定案后大部分无调用方 | 随 D2 删除 | P2 |
| **D13** | mutation 10 个变异点全打 v1 老架构 | `tests/mutation/` | 新组件零覆盖 | 重定向到生产入口 + `listing_plan`/`planes` | P2 |
| **D14** | `MAX_DEFINITIONS=2000` 静默截断 | `spec_parser.py:23-27` | 真实 ALS `fields:2000` 打满 | 截断产生 warning 进收据 | P2 |

---

## 四、重构计划

### 设计原则（从死命令反推，只有四条）

1. **数据值永不进 LLM 载荷** —— 保留 worker 内 `pyreadstat` 读取 + 收据白名单。这条已经做对了，不动。
2. **spec 需求文本、ALS 字段结构完整给 AI** —— 这是 AI 理解需求的前提。
3. **AI 产出 ListingPlan，本地执行器跑数据** —— 已建成（`listing_plan.py` + `listing_executor.py`，37/37 绿）。
4. **判据是来源（provenance），不是内容形态** —— 内容扫描退为兜底，仅保留 mass-dump 体量红线。

前三条的骨架**已经在仓库里了**。真正缺的是第 4 条：出域层还在用内容判据，把前三条的成果抹掉。所以这不是推翻重来，是**把出域层改成与已建成架构同一判据**。

### 阶段 0：止血（半天，D1-D4）

目标：让 AI 能看见 spec，让本地脚本能跑。

**0.1 出域扫描按来源生效（D1）**

`check_egress_v2` 签名加 `provenance`：

```python
def check_egress_v2(payload, context=None, *, provenance=None):
    # provenance: {json_path -> 'data' | 'spec' | 'document' | 'model'}
    # 只有 'data' 片段进 smart_scrub_structure
    # 其余原样放行；mass-dump 体量红线仍全局生效
```

来源从两处取，都已存在、不需要新机制：
- `src/index.js` 的 `TRUSTED_DOCUMENT_CONTENT` / `TRUSTED_LISTING_RECEIPT` / `CONTROL_PATHS` 标记
- `planes.js` 的 `planeOf(path)`（post-execute 已按 plane 处置，把结论透给 llm/stream）

未标记来源的片段（模型自己写的话、用户输入）→ 放行。数据值本来就进不到那里：它们只能经 `local_data_metadata` 或 listing 三工具，而这两条路的出口都是白名单收据。

**0.2 删掉 6 条行为封禁正则（D3）**

`src/index.js:317-383`。`planeAdmission` 只留：

```js
const path = extractPath(exec.arguments ?? {});
if (planeOf(path, config) === 'data') return deny(...);
// shell: 命令串里的绝对路径 token 命中数据域 → deny
```

`| python`、`Rscript`、`Get-Content` 本身不再是拒绝理由。

**0.3 `.sas7bdat` 在 bash 里降为审计（D4）**

`ai_operations_monitor.py` 相应规则从 BLOCK 改 记录。

**验收：** 4 个 integration FAIL 转 PASS，且 `test_bypass_matrix` 与 `test_security` 保持全绿。

### 阶段 1：单一出域引擎（1 天，D2 + D12）

1. 删 `EMERALD_EGRESS_V2` 开关与 v1 `check_egress`
2. `test_security.py`(62) / `test_bypass_matrix.py`(13) / `mutation/oracle.py` 改打生产入口
3. **这一步会暴露真实差异** —— v1 绿的用例在 v2 下可能红。每一条都要判：是 v2 缺检测（补），还是 v1 过度拦截（更新用例）。这是整个计划里唯一可能翻出新问题的地方，预留缓冲。
4. 删 D12 死代码

**验收：** 全套件打生产路径全绿；`grep EMERALD_EGRESS_V2` 无结果。

### 阶段 2：可用性（1 天，D5-D9）

- D5 staging 清扫
- D6 收据键对齐
- D7 ALS 词汇进白名单
- D8 删 sheet 名黑名单
- D9 密钥随 session

**验收：** `run_all.py` `TOTAL_FAILED_SUITES=0`；新增用例断言 ALS 列名（`PreText`/`ItemOrder`/`DatasetName`/`SASLabel`）原样可读。

### 阶段 3：真实数据门禁（D11 + D13-D14）

**这是最重要的一步，也是之前所有轮次都跳过的一步。**

之前每一轮修复都以"测试全绿"收尾，但门禁里没有一条"真实项目产出 listing"。所以每轮都能宣布完成，而你手里始终没有 listing。

- **V1（一级验收）：真实项目 + `status: completed` 收据**，四场景各一份，进 `run_all.py`。这条不过，不算交付。
- **V2 可用性保持族**：spec 字段名可读、需求条数与人工清点一致、含日期/SAS 字面量的 `write_file` 不被拦、spec 全文可达 AI
- V3 = D13，V4 = D14
- D11：提交，建立可回滚基线

---

## 五、验收判据（替换"拦截数=0"）

| # | 判据 | 现状 |
|---|---|---|
| A1 | 真实项目四场景各产出 `status: completed` | **未达成** |
| A2 | spec 需求文本、ALS 列名原样到达 AI | **未达成**（D1/D7） |
| A3 | SAS 数据值不出现在任何 LLM 载荷 | 已达成（收据白名单 + 37/37） |
| A4 | `run_all.py` `TOTAL_FAILED_SUITES=0` | **未达成**（4） |
| A5 | 全部安全用例打生产出域路径 | **未达成**（打 v1） |
| A6 | 本地脚本处理数据不被拦 | **未达成**（D3/D4） |

A3 是死命令，已经守住了。A1/A2/A6 是"能干活"，全部未达成——**这套系统当前的状态是：安全目标达成，可用性目标未达成。**

---

## 六、我没能验证的部分

- **你 Windows `.venv` 的真实依赖状态**。沙盒里 `pyreadstat`/`pyzipper`/`xlwt` 缺失，我临时装了才跑得动测试。你主机上需自行确认。
- **真实临床项目回放**。工作区内无真实数据（也不该有），A1 只能在你的环境验。
- **Node 侧 4 套件**在我环境能跑（`node_modules/@deepseek-ai/*` 齐备，v22.23.2），但 `npm` 缓存有 root 权限残留报了 EPERM，`e2e/run_installed_smoke.py` 的 tarball 安装路径未完整验证。
- **阶段 1 的用例差异规模**。v1→v2 会翻出多少真实分歧，我只能预判不能预知。

---

## 七、一句话

架构方向在最近这轮重构里已经掰对了（计划-执行两段式建成、37/37 绿），但**出域层还在用旧判据**，把新架构的成果又抹掉一次；同时**安全测试打的是没在生产跑的那套引擎**，所以这个矛盾一直没被门禁发现。先做阶段 0 的三件事（按来源扫描、删行为封禁、`.sas7bdat` 降级），你应该当天就能拿到第一份真实 listing。
