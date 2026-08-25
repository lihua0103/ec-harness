---
intent: 仅阻止真实 SAS 数据和 doc 目录外 Excel 数据进入模型上下文，同时允许 harness 完整读取 doc 内规格文本并自主编排业务执行
success_criteria: 两类受保护数据在模型请求和工具结果边界均被阻断，doc 内 Excel 规格正文与普通非数据文本可通过，Listing 业务执行不再因额外安全策略受限
risk_level: high
auto_approve: true
branch: master
worktree: false
dirty_worktree: allow
---

## Steps

- [ ] **Step 1: 固化两类数据边界回归测试**
action: 在现有 Python 与 Node 测试中添加最小回归案例，覆盖 SAS 数据、doc 外 Excel 数据、doc 内 Excel 规格文本和普通 harness 指令。
loop: false
verify: python -m pytest tests/unit/test_egress_v2_fix.py tests/unit/test_listing_security.py -q
gate: human

- [ ] **Step 2: 收敛来源平面分类**
action: 修改 src/planes.js 及调用上下文，使 doc 内 Excel 明确归入 document/specification 平面，doc 外 Excel 和 SAS/XPT 明确归入 data 平面，不以 Listing 场景或文件名猜测安全等级。
loop: until 来源分类测试通过
max_iterations: 3
verify: node tests/unit/planes_cases.mjs
gate: human

- [ ] **Step 3: 收敛模型出境检查**
action: 修改 security/egress_checkpoint.py、security/worker.py 和必要的 Node 接线，只对带可信来源标记的 SAS 数据与 doc 外 Excel 数据执行硬阻断；允许 doc 内规格全文与普通 harness 指令原样通过。
loop: until 出境边界回归测试通过
max_iterations: 3
verify: python -m pytest tests/unit/test_egress_v2_fix.py tests/unit/test_smart_guard_wiring.py -q
gate: human

- [ ] **Step 4: 收敛工具结果边界**
action: 修改 src/tool-result-guard.js，使 SAS 与 doc 外 Excel 的真实值不得回传模型，但 metadata-only receipt、doc 内规格正文和 harness 控制信息可通过。
loop: until Node integration 边界测试通过
max_iterations: 3
verify: python -m pytest tests/integration/test_plugin_runtime.py -q
gate: human

- [ ] **Step 5: 清理与新边界冲突的业务限制**
action: 检查本轮相关 Listing inspect 与 plan 路径，仅移除会阻止 harness 读取 doc 内完整规格文本或自主编排的安全限制，不重构执行器和 Excel writer。
loop: until Listing 回归测试通过
max_iterations: 3
verify: python -m pytest tests/unit/test_listing_e2e_fixes.py tests/unit/test_listing_security.py tests/unit/test_listing_plan_contract.py -q
gate: human

- [ ] **Step 6: 完整验证新边界**
action: 运行 Python、Node、语法和打包验证，确认两类泄露被阻断且 harness 非数据能力未被误限制。
loop: until 所有验证通过
max_iterations: 3
verify:
  - type: shell
    command: python -m pytest tests/unit tests/integration -q
  - type: shell
    command: python -m compileall -q security tests
  - type: shell
    command: node --check src/index.js
  - type: shell
    command: node --check src/tool-result-guard.js
  - type: shell
    command: npm pack --dry-run --json --cache .npm-cache
gate: human
