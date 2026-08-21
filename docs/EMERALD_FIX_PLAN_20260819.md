# Emerald Clinical Data Guard 缺陷修复计划

**依据**: `EMERALD_DEFECT_REPORT_MERGED_20260819.md`(6 P0 / 11 P1 / 18 P2 / 14 P3)
**架构决策**: 数据脱敏改为 **HMAC token 化**(不可逆、抗字典、同值同 token 保结构)。
LLM 按 medical_listing 惯例只吃 spec/表头结构、产出规则代码,真实数据值本地执行,不进 LLM。

---

## 核心架构变更:从"逐格猜敏感 + block/掩码"改为"数据区 HMAC token 化 + 区域策略"

### 病根
现系统在 `egress_checkpoint` 逐格正则判敏感:判不准就误杀(E2E-4 把消息 UUID 当受试者号 BLOCK 整轮对话 → "没法用"),漏了就放行(小写/日期格式一堆绕过)。

### 新模型
1. **数据区**(Excel/CSV/SAS 单元格值)→ `security/tokenizer.py` HMAC token 化。
   - `HMAC-SHA256(会话密钥, normalize(值))[:8]`,带类型前缀:`101-001`→`SUBJ_a3f9c2`,`2024-01-15`→`DATE_7b21e0`。
   - 会话密钥 = worker 进程启动时 `os.urandom(32)`,仅内存,绝不落盘/出域。
   - 同值同 token(LLM 可 join/去重/计数),高熵不可逆、抗字典。
2. **spec/需求/计算方式文本** → 按区域放行(sheet 名/内容分类已有 `detect_sheet_risk` 低风险白名单)。
3. **出境检查点** 保留为纵深防线:数据已 token 化后不再误杀正常对话;若仍检出裸 PII 说明 token 化漏了,才 block。
4. **身份哈希** `stable_hash` 改 HMAC 加盐(P3:无盐可字典反查低熵身份)。

---

## 分批路线图

### 第 0 批 —— 让系统能用(解除"没法用")【✅ 已完成 2026-08-19】
- **E2E-4** 扫描字段白名单化:`egress_checkpoint.py` 新增 `_METADATA_KEY_FIELDS`,元数据键(`id`/`rpcId`/`callId`/`requestId`/`uuid`/`traceId` 等)的标量值跳过内容 DLP。已验证:`messages[N].id='msg-101-001'` 不再误杀,content 内真实受试者号+日期仍拦。
- **E2E-2** 审计落盘 try/finally:`egress_checkpoint.check()` 指纹计算包 try/except,失败时 `fingerprint_error` 占位,审计仍写入。

### 第 1 批 —— HMAC token 化脱敏引擎(你的方案)【✅ 已完成 2026-08-19】
- 新增 `security/tokenizer.py`:`_SESSION_KEY=os.urandom(32)`(仅内存)+ `token_for(value,kind)` + `token_sub()`。token 形如 `[SUBJ:a3f9c2b1]`,同值同 token、casefold 归一化、HMAC 不可逆抗字典。
- `data_egress_guard._light_scrub/_heavy_scrub` 改用 token(替代固定 `[SUBJ]`/`[DATE]` 掩码)。替换顺序:日期→编码→受试者号→USUBJID(先具体后宽泛,避免语义前缀失真)。
- 测试同步(R-5 spec 优先):`light_scrub_covers_*`、`dd_mmm` 日期用例改断言 `[X:` 前缀;新增 `tokenizer_is_deterministic_within_session_and_irreversible`;`test_plugin_runtime` no-path 断言;mutation `light-subject-scrub` 更新。
- 验证:`run_all.py` 38/38 全绿、全 suite 0 失败;`run_mutation.py` 10/10 (100%)。
- **注**:审计/错误回执路径(`sanitize_error`、threat `evidence`、L3 prompt)保留固定掩码——审计必须不可关联(R-6),不该 token 化。

**环境发现**:报告称"dd_mmm_yyyy 偶发失败(flaky)"真因是**缺 `xlwt` 依赖**(测试用它造 .xls 夹具),非 flaky。装 `xlwt xlrd openpyxl` 后基线即 37/37 稳定全绿。建议加入 requirements/测试前置。

### 第 2 批 —— P0/P1 红线【✅ 大部完成 2026-08-19】
- **ST-P1-1** 大小写绕过：`patterns.py` 受试者/SAS日期/医学编码模式全加 `re.IGNORECASE`；`_light_scrub` inline 正则、`_DATA_VALUE_RES`、`NODE_DLP_PATTERNS`(+SAS_DATE)同步；`sync_patterns.py` 重新生成 `node_patterns.json`(6 处 flags:i)。新增红队 `lowercase_subject_and_sas_date_block`。
- **ST-P1-2** 不可见字符/NFKC：`scan_text` 归一化改 `unicodedata.normalize("NFKC")` + `_INVISIBLE_RE`(零宽族/U+FEFF/U+00AD/U+180E/bidi 控制符)。新增红队 `invisible_and_nfkc_bypass_block`(全角/软连字符/BOM/零宽)。
- **ST-P1-5** 开关反转：`check()` 判定改白名单式 fail-closed——只有明确 `shadow`/`disabled` 才不阻断，其余(含拼写错/未知/None)一律 enforce 阻断。
- **ST-P1-6** quickGuard 前缀注入：`patterns.js` safePatterns 改 `^...$` 全等 + `match[0].trim()`，`USUBJID=SCREENING-01-123456` 不再因含 Screening 被整体豁免(node 验证通过)。
- **ST-P1-7** 审计键名脱敏：`_safe_key` 改白名单式(`_SAFE_PATH_KEYS`)——只有已知协议结构键原样保留，其余(含中文业务键)一律 `[KEY:哈希]`；删除死代码 `_KEY_DLP_RES`。
- **ST-P1-3** TOCTOU：`egress_authz` authorize/consume 读-改-写全程持 `audit_log._exclusive_lock` 目录级排他锁。
- **ST-P1-4** 匿名坍缩：新增 `_has_identity`——user/session 任一缺失即拒绝授权/消费(fail-closed)，不再共享 anonymous 桶。
- 验证：run_all 40/40 全绿、mutation 10/10。

**ST-P0-2 授权内容/身份绑定 —— 部分完成，余项标注为设计变更**：
已落地可确定子项(P1-3 锁 + P1-4 身份)。**未做**"授权绑定被批准的具体内容指纹 + 绑定 exec.agent 身份":受 DSH 官方扩展点契约限制,`llm/stream` 处理器签名为 `(options, next)`,**消费侧拿不到 exec.agent**;且"批准一次放行下一条 dirty"是 TC-28 已固化的产品语义。要做内容指纹绑定(post-execute 授权时写入被批准内容的指纹，stream 消费时按当前请求内容指纹匹配)属跨扩展点设计变更,需走需求变更 + 改 TC-28,**留待专门设计,勿在收尾批次擅改产品语义**。

### 待办 —— 本地凭据通道(用户新需求 2026-08-19,非缺陷报告范围)【✅ 已完成 2026-08-19】
**场景**:`A1234567.txt` 之类文件是压缩包解压密码,形态碰巧像受试者号被 DLP 误伤。用户裁定:**密码只本地解压用、绝不进 LLM**,建**本地凭据通道**。
**已实现**:
- 新增配置 `credentialsDir`/`EMERALD_CREDENTIALS_DIR`(默认关闭)。`index.js` validateConfig 接入。
- `tool-result-guard.js` 新增 `isCredentialPath`(解析后绝对路径前缀判断,防 `../` 穿越,不靠文件名/内容形态——避免 ST-D-5 泄露通道)+ `credentialPlaceholder`。
- `safeToolResult` 最前置检查:credentialsDir 下文件返回 `CREDENTIAL_LOCAL_ONLY` 占位+真实路径,原值不进 LLM 上下文。纵深:若原值仍出现在 LLM 请求,egress_checkpoint 照样 token 化/拦截。
- master spec §5 配置表 + §4 数据处置表同步。集成测试 `test_credential_file_value_stays_local`。
- 验证:run_all 41/41 + 集成 16/16。
**注**:密码值绝不进 LLM;路径本身保留真实(agent 需交本地解压工具)。当前接 post-execute;解压工具具体接线(.zip 目前 `ZIP_MAYBE_DATA` 占位)待用户确认工具链后补。

### 第 3 批 —— P1 剩余 + 关键 P2【待续】
- ST-P1-8 AI 代码检查补 `__import__`/AST Call/eval/getattr/marshal;引号拼接绕过。
- ST-P1-9 extractor 表头白名单输出策略。
- ST-P2-3 worker/extractor env 白名单(防密钥收割)。
- ST-P2-4 遥测强制 DISABLED;ST-P2-6 Windows 路径分隔符;ST-P2-13 审计目录回项目内或走需求变更。
- ST-P2-1/2 base64/日期格式缺口。

### 第 4 批 —— 测试体系 + 文档 + P3【待续】
- ST-D-3/4 测试盲区(授权重放/并发、worker 协议注入、模式矩阵拆分)。
- ST-D-4 `egress_202608.jsonl` 写死(2026-09-01 必红)改动态月份。
- ST-D-1/2 文档编号统一 + 配置表补全。
- P3 择要:线程安全单例、审计 HMAC 链/fsync、递归深度上限。
- E2E-7 续跑 listing 全流程验证。

---

## 验证纪律
每批改完:`cd dsh-clinical-data-guard; $env:PYTHONIOENCODING='utf-8'; python tests/run_all.py`(需 37/37 全绿 + 各 suite 0 失败)。
Python 改动用 `python -m py_compile` 逐个校验语法。
