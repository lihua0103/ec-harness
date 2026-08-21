from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_project_delivery_contract():
    start = (ROOT / "start.ps1").read_text(encoding="utf-8")
    assert "DSH_HOME" in start
    assert "node_modules\\.bin\\dsh.CMD" in start
    assert "$RuntimeBin --profile clinical" in start
    assert "$npmCommand ci --prefix" in start
    assert "$pnpmCommand install --frozen-lockfile --prefer-offline" in start
    assert "npm install --global pnpm@11.19.0" in start
    assert "([version]'24.0.0')" in start
    assert "([version]'3.10.0')" in start
    assert "Node.js 24+ and npm are required" in start
    assert "Python 3.10+ is required" in start
    assert "ForcePortable" not in start
    assert "Portable" not in start
    assert "Save-WebFile" not in start
    assert "Start-Process '$url'" in start
    assert (ROOT / ".tools").exists() is False

    runtime = json.loads((ROOT / "runtime" / "package.json").read_text(encoding="utf-8"))
    assert runtime["dependencies"]["@deepseek-ai/dsh"] == "^0.1.0-rc.6"
    assert runtime["allowScripts"]["node-pty@1.1.0"] is True
    assert runtime["allowScripts"]["koffi@3.1.5"] is True

    plugin = json.loads(
        (ROOT / "dsh-clinical-data-guard" / "package.json").read_text(encoding="utf-8")
    )
    assert plugin["version"] == "1.0.5"
    assert "src/branding.js" in plugin["files"]
    assert "assets/branding/favicon.svg" in plugin["files"]
    assert "@deepseek-ai/dsh-host-webserver" in plugin["peerDependencies"]

    branding = (
        ROOT / "dsh-clinical-data-guard" / "src" / "branding.js"
    ).read_text(encoding="utf-8")
    assert "tapIndex" in branding
    assert "'/manifest.webmanifest'" in branding
    assert "'/favicon.svg'" in branding

    profile = json.loads(
        (ROOT / ".dsh" / "profiles" / "clinical" / "package.json").read_text(encoding="utf-8")
    )
    assert profile["dependencies"]["emerald-clinical-data-guard"] == "link:../../../dsh-clinical-data-guard"
    assert profile["dsh"]["profile"]["bundles"] == [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "emerald-clinical-data-guard",
    ]

    lock = (ROOT / ".dsh" / "profiles" / "clinical" / "pnpm-lock.yaml").read_text(encoding="utf-8")
    assert "link:../../../dsh-clinical-data-guard" in lock
    assert "G:/" not in lock and "C:/" not in lock

    smoke = (
        ROOT / "dsh-clinical-data-guard" / "tests" / "e2e" / "installed_smoke.js"
    ).read_text(encoding="utf-8")
    assert "C:/Users" not in smoke

    for path in (
        ROOT / "README.md",
        ROOT / "dsh-clinical-data-guard" / "README.md",
        ROOT / "docs" / "EMERALD_CLINICAL_MASTER_SPEC.md",
    ):
        text = path.read_text(encoding="utf-8")
        assert "C:\\Users" not in text
        assert "127.0.0.1:3081" not in text


def main() -> int:
    try:
        test_project_delivery_contract()
    except Exception as error:
        print(f"FAIL project-delivery-contract: {error}")
        return 1
    print("PASS project-delivery-contract")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
