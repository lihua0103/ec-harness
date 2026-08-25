import sys
from pathlib import Path
sys.path.insert(0, str(Path("python").resolve()))

from security.egress_checkpoint import check_egress, EgressViolation

print("=" * 70)
print("Scenario 1: Subject ID Egress Test")
print("=" * 70)
try:
    result = check_egress([{"role": "user", "content": "Subject A1234567 enrolled"}])
    print("FAIL: Subject ID was NOT blocked")
    print("Result:", result)
except EgressViolation as e:
    print("PASS: Subject ID was successfully blocked")
    print("Audit ID:", e.audit_id)
    print("Threats:", len(e.threats))

print("\n" + "=" * 70)
print("Scenario 2: Clinical Data Table Egress Test")
print("=" * 70)
try:
    result = check_egress([{
        "role": "user", 
        "content": "Patient demographics: USUBJID, AGE, SEX\\n001-001, 45, M\\n001-002, 52, F"
    }])
    print("FAIL: Clinical data was NOT blocked")
    print("Result:", result)
except EgressViolation as e:
    print("PASS: Clinical data was successfully blocked")
    print("Audit ID:", e.audit_id)
    print("Threats:", len(e.threats))

print("\n" + "=" * 70)
print("Scenario 3: Normal Content Should Pass")
print("=" * 70)
try:
    result = check_egress([{"role": "user", "content": "How to create a listing in SAS?"}])
    print("PASS: Normal content was allowed")
    print("egress_disabled =", result.get("egress_disabled"))
except EgressViolation as e:
    print("FAIL: Normal content was incorrectly blocked")
    print("Audit ID:", e.audit_id)

print("\n" + "=" * 70)
print("Test Complete")
print("=" * 70)
