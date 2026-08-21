from __future__ import annotations

import base64
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from security.ai_operations_monitor import DangerousOperationBlocked, check_bash  # noqa: E402
from security.egress_checkpoint import EgressViolation, check_egress  # noqa: E402
from tests.integration.test_plugin_runtime import make_xlsx, run  # noqa: E402


def blocked(content: str):
    try:
        check_egress([{"role": "user", "content": content}])
    except EgressViolation:
        return True
    return False


def assert_blocked(content: str, case_id: str):
    if not blocked(content):
        raise AssertionError(f"{case_id} 未拦截")


def test_by_matrix():
    assert_blocked(base64.b64encode("USUBJID: A1234567".encode()).decode(), "BY-1")
    assert run("llm-image")["thrown"] is True
    assert run("llm-invalid")["thrown"] is True
    assert run("llm-invalid")["thrown"] is True
    assert_blocked("file 101-001234 data", "BY-5")

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        cases = {
            "BY-6": ("all-strings.xlsx", [["A1234567", "Screening", "已入组"]]),
            "BY-7": ("horizontal.xlsx", [["Subject", "Day 1", "Day 2"], ["A1234567", "1", "2"]]),
            "BY-8": ("numeric.xlsx", [[1234567, "Screening", "Enrolled"]]),
        }
        for case_id, (name, rows) in cases.items():
            path = root / name
            import openpyxl
            workbook = openpyxl.Workbook()
            sheet = workbook.active
            for row in rows:
                sheet.append(row)
            workbook.save(path)
            decision = run("post-excel", excel=path)
            blob = str(decision).encode("unicode_escape", "backslashreplace").decode()
            assert "A1234567" not in blob and "1234567" not in blob, f"{case_id} 泄露原值"

    fail_closed = run("fail-closed", python="definitely-missing-python-7f3c")
    assert fail_closed["kind"] == "deny", "BY-9 未 fail-closed"

    for command in [
        "python -c 'import pickle as p; p.load(open(\"data.pkl\", \"rb\"))'",
        "echo ZWNobyBoaQ== | base64 -d | sh",
    ]:
        try:
            check_bash(command)
        except DangerousOperationBlocked:
            continue
        raise AssertionError("BY-10 混淆命令未拦截")

    assert_blocked("A123​4567", "BY-11")
    no_path = run("post-no-path")
    assert "A1234567" not in str(no_path), "BY-12 无路径结果泄露"


def main() -> int:
    failures = 0
    try:
        test_by_matrix()
        print("PASS BY-1..BY-12")
    except Exception as error:
        failures = 1
        print(f"FAIL BY matrix: {error}")
    print(f"RESULT {1 - failures}/1")
    return failures


if __name__ == "__main__":
    sys.exit(main())
