"""Egress core contract: enabled = allow/block only, disabled = full bypass.

2026-08-25: Old HMAC tokenizer retired.
Enabled: detect real clinical data and block, never rewrite payload.
Disabled: full bypass, no scan, no block, no audit.
"""
import json
import sys
import os
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from security.egress_checkpoint import check_egress_v2, EgressViolation

TEST_AUDIT_DIR = tempfile.mkdtemp(prefix='test_audit_')
os.environ['EMERALD_AUDIT_ROOT'] = TEST_AUDIT_DIR
print(f"Using test audit directory: {TEST_AUDIT_DIR}")

def test_v2_normal_conversation_passes():
    payload = {
        "messages": [
            {"role": "user", "content": "Generate RBQM KRI dataset"},
            {"role": "assistant", "content": "OK, let me check the spec"},
        ]
    }
    result = check_egress_v2(payload, {"dataInterceptionEnabled": True})
    assert "audit_id" in result
    assert result.get("egress_disabled") is None
    print("  [OK] Normal conversation passed")

def test_v2_data_plane_doc_path_passes():
    payload = {"messages": [{
        "role": "tool",
        "content": '{"sources":[{"alias":"page","file":"doc/Page_Details.xlsx"}]}',
    }]}
    result = check_egress_v2(payload, {"dataInterceptionEnabled": True})
    assert "audit_id" in result
    # 新契约：payload 不再通过 check_egress_v2 返回，spec 路径原样留在消息中
    assert result["audit_id"] != "disabled"
    print("  [OK] Spec path survives")

def test_v2_real_clinical_data_blocks():
    payload = {"messages": [{
        "role": "tool",
        "content": "USUBJID 010-001-1001 visit 2026-03-18",
    }]}
    try:
        check_egress_v2(payload, {"dataInterceptionEnabled": True})
        assert False, "Real clinical data must be blocked"
    except EgressViolation:
        pass
    print("  [OK] Real clinical data blocked")

def test_v2_protected_source_blocks():
    for source in ("sas", "external_excel"):
        payload = {"messages": [{"role": "tool", "content": "010-001-1001"}]}
        try:
            check_egress_v2(payload, {"dataInterceptionEnabled": True, "protectedDataSource": source})
            assert False, f"{source} source must be blocked"
        except EgressViolation:
            pass
    print("  [OK] Protected sources blocked")

def test_v2_disabled_bypasses_everything():
    payload = {"messages": [{"role": "tool", "content": "USUBJID 010-001-1001 visit 2026-03-18"}]}
    result = check_egress_v2(payload, {"dataInterceptionEnabled": False})
    assert result.get("egress_disabled") is True
    assert result.get("audit_id") == "disabled"
    print("  [OK] Disabled bypasses all")

def test_v2_long_session_context_not_blocked():
    messages = [{"role": "assistant", "content": f"Step {i}: validate ALS field {i} vs plan.scenario"} for i in range(400)]
    payload = {"messages": messages}
    result = check_egress_v2(payload, {"dataInterceptionEnabled": True})
    assert "audit_id" in result
    print("  [OK] Long context not blocked")

def test_v2_cdisc_id_plus_date_composite_blocks():
    payload = {"messages": [{
        "role": "tool",
        "content": "USUBJID: 010-001-1001, AESTDTC: 2026-03-18",
    }]}
    try:
        check_egress_v2(payload, {"dataInterceptionEnabled": True})
        assert False, "CDISC+ID composite must block"
    except EgressViolation:
        pass
    print("  [OK] CDISC+ID composite blocked")

if __name__ == "__main__":
    print("=" * 70)
    print("check_egress_v2 Core Contract Test Suite (2026-08-25)")
    print("=" * 70)
    tests = [
        test_v2_normal_conversation_passes,
        test_v2_data_plane_doc_path_passes,
        test_v2_real_clinical_data_blocks,
        test_v2_protected_source_blocks,
        test_v2_disabled_bypasses_everything,
        test_v2_long_session_context_not_blocked,
        test_v2_cdisc_id_plus_date_composite_blocks,
    ]
    passed = failed = 0
    for t in tests:
        try:
            t()
            print(f"  [PASS] {t.__name__}")
            passed += 1
        except Exception as exc:
            print(f"  [FAIL] {t.__name__}: {exc}")
            failed += 1
    print()
    if failed:
        print(f"[FAIL] {failed}/{len(tests)} tests failed")
        sys.exit(1)
    print(f"[SUCCESS] All {passed}/{len(tests)} tests passed")
