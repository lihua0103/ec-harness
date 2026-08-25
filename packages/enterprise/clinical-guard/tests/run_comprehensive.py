import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Python 测试（需要 PYTHONPATH）
PYTHON_TESTS = [
    "tests/unit/test_code_sandbox.py",
    "tests/unit/test_listing_code_lane.py",
    "tests/unit/test_listing_security.py",
    "tests/unit/test_listing_plan_contract.py",
    "tests/unit/test_listing_e2e_fixes.py",
    "tests/unit/test_security.py",
    "tests/unit/test_egress_v2_fix.py",
    "tests/integration/test_plugin_runtime.py",
    "tests/integration/test_runtime_resilience.py",
    "tests/integration/test_branding.py",
    "tests/integration/test_plugin_contract.py",
    "tests/bypass/test_bypass_matrix.py",
]

def main():
    env = os.environ.copy()
    env["PYTHONPATH"] = str(ROOT / "python")
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    
    failed = 0
    passed = 0
    
    print("=" * 70)
    print("Running Python Tests")
    print("=" * 70)
    
    for test in PYTHON_TESTS:
        test_path = ROOT / test
        if not test_path.exists():
            continue
            
        print(f"\n{'=' * 70}")
        print(f"Test: {test}")
        print('=' * 70)
        
        result = subprocess.run(
            [sys.executable, str(test_path)],
            cwd=ROOT,
            env=env,
            capture_output=False
        )
        
        if result.returncode == 0:
            passed += 1
            print(f"PASS: {test}")
        else:
            failed += 1
            print(f"FAIL: {test}")
    
    print("\n" + "=" * 70)
    print("Running TypeScript Tests")
    print("=" * 70)
    
    result = subprocess.run(
        ["npx", "vitest", "run", "tests/unit/"],
        cwd=ROOT,
        env=env,
        capture_output=False
    )
    
    if result.returncode == 0:
        passed += 1
        print("PASS: TypeScript tests")
    else:
        failed += 1
        print("FAIL: TypeScript tests")
    
    print("\n" + "=" * 70)
    print("Test Summary")
    print("=" * 70)
    print(f"Passed: {passed}")
    print(f"Failed: {failed}")
    print(f"Total: {passed + failed}")
    
    if failed == 0:
        print("\nAll tests passed!")
        return 0
    else:
        print(f"\n{failed} test(s) failed")
        return 1

if __name__ == "__main__":
    sys.exit(main())
