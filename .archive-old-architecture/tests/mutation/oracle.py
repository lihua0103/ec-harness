from __future__ import annotations

import base64
import sys
from pathlib import Path

sys.path.insert(0, str(Path.cwd().resolve()))

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
    must_allow_egress("report-A1234567-final.xlsx")
    must_allow_short_base64_candidates()
    must_block_key_name()
    must_block_full_request_auxiliary_fields()
    assert Path("security/patterns.py").exists()


if __name__ == "__main__":
    main()
