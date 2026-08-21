# 临床数据零出域改造方案（v1.0，2026-08-20）

> 审计结论前提：smart_guard.py（白名单统一token化）已实现但未接线（P0死代码）；
> 生产三车道为黑名单正则，新形态实测放行。本方案 = demo替身主防线 + smart_guard兜底双层结构。

## 目标不变量
- I1: AI上下文永不出现 realDataRoot 下任何单元格原值
- I2: spec/ALS/template 走 profile='spec'，散文/结构词零改写
- I3: report辅助数据集仅表头/结构/字段出域（复用 EXCEL_HEADERS_ONLY）
- I4: 一切误读数据白名单式统一 HMAC token 化，不认识≠放过；BLOCK仅剩 mass-dump 一条

## 阶段0 基线（0.5h）
git add -A && git commit（当前master零commit）；pip install -r requirements.txt 补xlwt；
tests/run_all.py 必须 TOTAL_FAILED_SUITES=0。

## 阶段1 接线 smart_guard（1天，P0）
1.1 worker.py scrub_text/scrub_row 分支 → smart_scrub_text(text, profile)；
    needs_user 仅 is_mass_data_dump(stats)；返回 tokens_hashed/data_lines。
1.2 egress_checkpoint.py 追加 check_egress_v2：smart_scrub_structure + 复用
    _request_evidence/_log_audit 审计；仅 mass-dump 抛 EgressViolation；
    返回 token 化 payload。灰度开关 EMERALD_EGRESS_V2=1，旧 check_egress 保留回滚。
1.3 index.js stream钩子：check.tokens_hashed>0 时 yield* next({...options, ...check.payload})
    改写载荷放行。⚠️必验：dsh-llm 的 next() 是否接受改写 options（查.d.ts或假provider集成测试）；
    不支持则降级：stream侧只拦mass-dump，tokens_hashed>0 记WARN审计放行
    （写入侧已全覆盖，残余仅用户亲手粘贴）。
1.4 package.json files 数组补 "security/smart_guard.py"（当前发布包缺失）；
    scripts/sync_patterns.py 重新生成；patterns.js scanDlp 降级为参数快筛。
1.5 验收：新形态(Pt#4521/点分日期/中文行)出域零原值数字；spec profile 零改写；
    token产物重扫幂等（根治8/19会话钉死）；≥200数据行走用户决策。

## 阶段2 demo替身车道（3-4天）
目录：data_real/（AI一切工具拒绝）、data_demo/ + manifest.json（AI自由读）、
spec/（全量放行）、output/（本地写，AI只见DATA_BLOCKED）。
流程：本地build_demo_replica → AI读spec+demo写listing程序（manifest取数，禁硬编码路径）
→ 同一程序manifest切real本地跑真实数据 → stdout/报错栈过阶段1token化。

2.2 security/table_structure.py：从 excel_header_extractor.py 抽共享
    （_score_row/_find_header_end_row/_detect_orientation/_extract_merged_info），
    覆盖多行表头/不规则/横纵向/合并单元格。
2.3 security/demo_replica.py 合成规则（构造性，无识别判定，判定不确定→整格合成fail-closed）：
    表头区逐字保留；数据区无条件合成；项目级HMAC密钥 var/demo_replica.key（0600，跨会话稳定）
    同值同像保join；日期→2001-01-01+(HMAC mod 3650)天按源格式；数字→同位数HMAC派生；
    编号→保骨架换值；自由文本→DEMO_<hex6>；空值保留。
    sas7bdat: pyreadstat读→demo落xpt/csv+列元数据，manifest记真实格式，取数层按格式分派。
    zip: 解包逐文件处理重打包；密码zip走credentialsDir通道。
2.4 泄漏自检（生成流程内强制）：demo产物字节级不含任何≥4字符真实数据区原值，失败销毁产物。
2.5 守卫接线：ai_operations_monitor 新增demoDataLane——realDataRoot前缀一切通用工具拒绝
    （绝对路径前缀判据防../穿越）、demoDataRoot放行；tool-result-guard.js demo路径直通/
    real路径恒DATA_BLOCKED；validateConfig 新增 demoDataLane/realDataRoot/demoDataRoot
    （enabled时必填且不得互含）。
2.6 worker新增 build_demo_replica 操作 + defineTool（对齐local_data_metadata写法），
    返回仅统计摘要零数据值；另供 python -m security.demo_replica CLI。
2.7 验收：字节级零残留；确定性/跨表join一致；结构等价（sheet/列名/行数/dtype）；
    real被拒有审计demo直通；端到端夹具项目demo开发real运行产出一致。

## 阶段3 灰度（1天）
shadow跑真实项目1天核对审计分布→切enforce+demoDataLane=enabled→
用8/19钉死场景回归（断言token化放行非拦死）→分三笔commit，tag zero-egress-v1。

## 验收矩阵
读real任意工具=拒绝审计 | 读demo=直通 | 读spec=零改写 | 读report辅助=仅表头 |
误读未知形态=token化不BLOCK | 真实运行报错栈=token化 | ≥200行=用户决策 |
token重扫=幂等 | demo构建=字节级零残留

## 残余风险（明示接受）
1. 用户亲手粘贴少量真实数据（若1.3 next()传参不支持，为唯一原值通道）
2. 散文≤2位小编号放行（spec可读性，smart_guard已明示）
3. demo只保形态不保分布，分布依赖逻辑靠manifest双跑在real阶段验证
4. 依赖CVE未审计（独立事项 npm audit + pip-audit）

## 工作量
阶段0: 0.5h → 阶段1: 1天 → 阶段2: 3-4天 → 阶段3: 1天。严格按序，1是2的兜底前提。
