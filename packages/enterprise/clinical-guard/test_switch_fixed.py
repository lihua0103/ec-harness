import sys
from pathlib import Path
sys.path.insert(0, str(Path("python").resolve()))

from security.egress_checkpoint import check_egress, EgressViolation

print("=" * 70)
print("Test: Egress Switch with CORRECT key name")
print("=" * 70)

# 测试1：开关开启时（默认）
print("\n[Test 1: dataInterceptionEnabled=True - Should BLOCK]")
try:
    result = check_egress(
        [{"role": "user", "content": "Subject A1234567 enrolled"}],
        {"dataInterceptionEnabled": True}
    )
    print("  FAIL: Not blocked when switch is ON")
except EgressViolation as e:
    print(f"  PASS: Blocked when switch is ON (audit: {e.audit_id})")

# 测试2：开关关闭时
print("\n[Test 2: dataInterceptionEnabled=False - Should ALLOW]")
try:
    result = check_egress(
        [{"role": "user", "content": "Subject A1234567 enrolled"}],
        {"dataInterceptionEnabled": False}
    )
    print(f"  PASS: Allowed when switch is OFF (egress_disabled: {result.get('egress_disabled')})")
except EgressViolation as e:
    print(f"  FAIL: Still blocked when switch is OFF (audit: {e.audit_id})")

# 测试3：开关关闭时，临床表格也应该放行
print("\n[Test 3: dataInterceptionEnabled=False with Clinical Data - Should ALLOW]")
try:
    result = check_egress(
        [{"role": "user", "content": "USUBJID, AGE, SEX\n001-001, 45, M\n001-002, 52, F"}],
        {"dataInterceptionEnabled": False}
    )
    print(f"  PASS: Clinical data allowed when switch is OFF")
except EgressViolation as e:
    print(f"  FAIL: Clinical data still blocked when switch is OFF")

# 测试4：没有context参数时（使用环境变量默认值）
print("\n[Test 4: No context - Should use env default (enabled)]")
try:
    result = check_egress([{"role": "user", "content": "Subject A1234567 enrolled"}])
    print("  FAIL: Not blocked with default env")
except EgressViolation as e:
    print(f"  PASS: Blocked with default env (audit: {e.audit_id})")

print("\n" + "=" * 70)
print("Switch Test Complete")
print("=" * 70)
