from __future__ import annotations

import base64
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path.cwd().resolve()))

from security.ai_operations_monitor import DangerousOperationBlocked, check_bash
from security.data_egress_guard import ClinicalDataDetector, StreamingScrubber
from security.egress_authz import authorize_category
from security.egress_checkpoint import EgressViolation, check_egress


def must_block_egress(content: str) -> None:
    try:
        check_egress([{"role": "user", "content": content}])
    except EgressViolation:
        return
    raise AssertionError("egress mutant survived")


def must_allow_egress(content: str) -> None:
    try:
        check_egress([{"role": "user", "content": content}])
    except EgressViolation:
        raise AssertionError("safe filename exemption mutant survived")


def must_block_full_request_auxiliary_fields() -> None:
    payload = {
        "messages": [{"role": "user", "content": "请生成列表规范。"}],
        "system": "Subject A1234567",
    }
    try:
        check_egress(payload)
    except EgressViolation:
        return
    raise AssertionError("full-request scope mutant survived")


def must_block_bash(command: str) -> None:
    try:
        check_bash(command)
    except DangerousOperationBlocked:
        return
    raise AssertionError("operation mutant survived")


def must_block_key_name() -> None:
    """FIX-2 (R-7): 顶层敏感键名必须触发出域阻断。"""
    try:
        check_egress({"A1234567": "value", "messages": [{"role": "user", "content": "hi"}]})
    except EgressViolation:
        return
    raise AssertionError("key-name scan mutant survived")


def must_allow_short_base64_candidates() -> None:
    """NFR-2: 短 base64 候选不触发误报。"""
    try:
        check_egress([{"role": "user", "content": "ref dGVzdDEyMw done"}])
    except EgressViolation:
        raise AssertionError("short base64 false positive")


def main() -> None:
    must_block_egress("Subject A1234567")
    must_block_egress(base64.b64encode("USUBJID: A1234567".encode()).decode())
    must_block_egress("A123​4567")
    must_allow_egress("report-A1234567-v2024-08-18.xlsx")
    must_allow_short_base64_candidates()
    must_block_key_name()
    must_block_full_request_auxiliary_fields()
    must_block_bash("cat data.sas7bdat")
    must_block_bash("strings data.sas7bdat")
    must_block_bash("strings data.xlsx")
    # cp 不在 cat/head/tail/strings/xxd/od 模式内，仅命中独立 .sas7bdat 模式。
    must_block_bash("cp data.sas7bdat /tmp/")
    must_block_bash("python -c 'import pickle as p; p.load(open(\"x\", \"rb\"))'")
    must_block_bash("echo aGVsbG8= | base64 -d | sh")

    detector = ClinicalDataDetector()
    scrubber = StreamingScrubber(detector)
    low, low_result = scrubber.scrub_row(["A1234567"], 1, False)
    assert "A1234567" not in " ".join(low), "scrubber mutant survived"
    assert low_result.risk_level.name == "SUSPICIOUS_LOW"

    sensitive, sensitive_result = scrubber.scrub_row(
        ["A1234567", "2024-03-05", "Screening"], 2, True
    )
    assert "A1234567" not in " ".join(sensitive), "sensitive scrubber mutant survived"
    assert sensitive_result.risk_level.name == "SENSITIVE", "sensitive classifier mutant survived"

    with tempfile.TemporaryDirectory() as root:
        record = authorize_category(root, "oracle-user", "oracle-session", "L3_ALLOW_AUDITED", "oracle-operator")
        assert record["ok"], "authorization mutant survived"

    assert Path("security/patterns.py").exists()


if __name__ == "__main__":
    main()
