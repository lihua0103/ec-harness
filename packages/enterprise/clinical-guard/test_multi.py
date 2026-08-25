import sys
from pathlib import Path
sys.path.insert(0, str(Path("python").resolve()))

from security.egress_checkpoint import check_egress, EgressViolation

# 测试更明显的临床数据
test_cases = [
    ("Subject ID", "Subject A1234567 enrolled"),
    ("USUBJID in text", "The USUBJID 001-001 has adverse event"),
    ("Clinical table", "USUBJID, AGE, SEX\n001-001, 45, M\n001-002, 52, F"),
    ("Clinical keywords", "Patient with adverse event AE123456"),
    ("CDISC domain", "DM domain data: subject demographics"),
]

print("=" * 70)
print("Egress Interception Test - Multiple Scenarios")
print("=" * 70)

for name, content in test_cases:
    print(f"\n[{name}]")
    try:
        result = check_egress([{"role": "user", "content": content}])
        audit_id = result.get("audit_id", "unknown")
        print(f"  NOT BLOCKED - Result: {audit_id}")
    except EgressViolation as e:
        print(f"  BLOCKED - Audit: {e.audit_id}, Threats: {len(e.threats)}")
