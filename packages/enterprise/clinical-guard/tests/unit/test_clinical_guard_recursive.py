"""listing 收据在结构化出域扫描中的递归回归测试。"""

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
# 2026-08-25 架构迁移：Python 运行时已移入 python/ 子目录。
PYTHON_ROOT = ROOT / "python"
sys.path.insert(0, str(PYTHON_ROOT))

from security import egress_checkpoint
from security.egress_checkpoint import EgressCheckpoint, _sign_clinical_guard


def _receipt(**overrides):
    value = {
        "clinicalGuard": "CLINICAL_LISTING_INSPECTION",
        "status": "ready",
        "stage": "inspect",
        "schema": {"dm": ["USUBJID", "SUBJID", "SITEID"]},
        "schemaFingerprint": "sha256:test",
        "dataClass": "METADATA_ONLY",
        "documents": [],
        "datasets": [],
        "missing": [],
        "warnings": [],
    }
    value.update(overrides)
    return value


def _sign(receipt: dict) -> dict:
    """按 _verify_clinical_guard_signature 的 critical_fields 口径补 HMAC。

    信任路径要求 EMERALD_SIGNING_SALT 已配置且签名匹配；生产端该盐由部署
    提供（当前未配置，见 2026-08-25 审计），单测在此显式注入以覆盖签名分支。
    """
    critical = {
        key: receipt.get(key)
        for key in ("listingId", "schemaFingerprint", "stage", "status", "dataClass")
        if receipt.get(key) is not None
    }
    receipt["signature"] = _sign_clinical_guard(receipt["clinicalGuard"], critical)
    return receipt


def test_nested_listing_receipt_is_not_scanned(monkeypatch):
    # _EMERALD_SIGNING_SALT 在模块导入时绑定，需直接 patch 模块属性。
    monkeypatch.setattr(egress_checkpoint, "_EMERALD_SIGNING_SALT", b"unit-test-salt")
    payload = {"messages": [{"content": [{"type": "tool-result", "result": {
        "ok": True,
        "inspection": _sign(_receipt()),
    }}]}]}
    assert EgressCheckpoint().recognizer.scan_structured(payload, "payload") == []


def test_unmarked_metadata_is_still_scanned():
    payload = {"inspection": _receipt(clinicalGuard=None)}
    threats = EgressCheckpoint().recognizer.scan_structured(payload, "payload")
    assert threats


def test_incomplete_or_mixed_receipt_is_not_trusted():
    payload = {"inspection": _receipt(dataClass="PATIENT_LEVEL", patient_id="A1234567")}
    threats = EgressCheckpoint().recognizer.scan_structured(payload, "payload")
    assert threats
