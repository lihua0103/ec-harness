from __future__ import annotations

import os
import runpy
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TARGETS = [
    ROOT / "tests" / "unit" / "test_security.py",
    ROOT / "tests" / "integration" / "test_plugin_runtime.py",
    ROOT / "tests" / "integration" / "test_runtime_resilience.py",
    ROOT / "tests" / "integration" / "test_branding.py",
    ROOT / "tests" / "integration" / "test_plugin_contract.py",
    ROOT / "tests" / "bypass" / "test_bypass_matrix.py",
]


def main() -> int:
    os.chdir(ROOT)
    failed = 0
    for target in TARGETS:
        print(f"\n=== {target.relative_to(ROOT)} ===")
        try:
            runpy.run_path(str(target), run_name="__main__")
        except SystemExit as exc:
            code = int(exc.code or 0)
            failed += code
        except Exception:
            failed += 1
            raise
    print(f"\nTOTAL_FAILED_SUITES={failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
