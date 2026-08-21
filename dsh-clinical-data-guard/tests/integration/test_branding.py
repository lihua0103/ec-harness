from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DRIVER = ROOT / "tests" / "integration" / "branding_driver.js"


def test_ui_branding_uses_official_webserver_extension():
    env = os.environ.copy()
    env["NODE_PATH"] = str(ROOT)
    result = subprocess.run(
        ["node", str(DRIVER)],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    evidence = json.loads(result.stdout)
    assert evidence == {
        "brandedTitle": True,
        "manifestBranded": True,
        "faviconBranded": True,
        "officialRoutes": True,
    }


def main() -> int:
    failures = 0
    try:
        test_ui_branding_uses_official_webserver_extension()
        print("PASS test_ui_branding_uses_official_webserver_extension")
    except Exception as error:
        failures = 1
        print(f"FAIL test_ui_branding_uses_official_webserver_extension: {error}")
    print(f"RESULT {1 - failures}/1")
    return failures


if __name__ == "__main__":
    sys.exit(main())
