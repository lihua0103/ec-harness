"""CGB3002-TEST 真实项目端到端验证：模拟 agent 读需求文档与数据文件的完整链路。"""
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(r"g:\home\dsh-guard\dsh-clinical-data-guard")
PROJECT = Path(r"G:\home\Clinical-Data\CGB3002-TEST")
os.chdir(ROOT)
os.environ["PYTHON"] = sys.executable
os.environ["PLUGIN_PYTHON"] = sys.executable
os.environ.setdefault("PYTHONIOENCODING", "utf-8")

SCENARIOS = [
    # (driver 场景, 环境补充, 断言函数)
    ("llm-dirty", None, lambda o: o.get("streamed") is True and "A1234567" in json.dumps(o, ensure_ascii=False)),
    ("fetch-database", None, lambda o: "A1234567" not in json.dumps(o, ensure_ascii=False)),
]

# 受试者级泄露标记。站点代码（UAT_006/Site Number）是 spec 要求的报告分组维度，
# 属站点标识而非受试者标识，不在数据红线内。
MARKERS = ["01001", "01002", "S005", "S006", "346.0", "08 Jun 2026"]


def post_excel(path):
    assert path.is_file(), f"真实项目文件不存在: {path}"
    env = dict(os.environ, EXCEL_FILE=str(path))
    result = subprocess.run(
        ["node", str(ROOT / "tests/integration/plugin_driver.js"), "post-excel"],
        cwd=ROOT, env=env, capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=60,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


failures = []
for scenario, _, check in SCENARIOS:
    result = subprocess.run(
        ["node", str(ROOT / "tests/integration/plugin_driver.js"), scenario],
        cwd=ROOT, capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=60,
    )
    assert result.returncode == 0, result.stderr
    output = json.loads(result.stdout)
    status = "PASS" if check(output) else "FAIL"
    if status == "FAIL":
        failures.append(scenario)
    print(status, scenario, json.dumps(output, ensure_ascii=False)[:110])

for name in ["crViewer.xls", "RT01_DM Status Report Specification_11Aug2026.xlsx"]:
    decision = post_excel(PROJECT / "doc" / name)
    blob = json.dumps(decision, ensure_ascii=False)
    leaked = [m for m in MARKERS if m in blob]
    status = "PASS" if decision.get("kind") == "accept" and not leaked else "FAIL"
    if status == "FAIL":
        failures.append(name)
    print(status, "post-excel", name, "leak=" + str(leaked),
          blob[:130])

# PROD.xls 是 SpreadsheetML XML 伪装的 .xls：fail-closed（CHECK_FAILED），无泄露。
decision = post_excel(PROJECT / "doc" / "RT01_V1.0_29JUN2026_PROD.xls")
blob = json.dumps(decision, ensure_ascii=False)
content = decision.get("content", [])
value = {}
if content and isinstance(content[0], dict):
    try:
        value = json.loads(content[0].get("text", "{}"))
    except json.JSONDecodeError:
        value = {}
status = "PASS" if value.get("clinicalGuard") == "CHECK_FAILED" else "FAIL"
if status == "FAIL":
    failures.append("PROD.xls")
print(status, "post-excel PROD.xls(XML伪装)", blob[:150])

print("E2E_RESULT:", "ALL_PASS" if not failures else f"FAILED={failures}")
sys.exit(1 if failures else 0)
