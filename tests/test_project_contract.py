from __future__ import annotations

import json
import hashlib
import re
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_project_delivery_contract():
    start = (ROOT / "start.ps1").read_text(encoding="utf-8")
    assert "DSH_HOME" in start
    assert "node_modules\\.bin\\dsh.CMD" in start
    assert "$RuntimeBin --profile clinical" in start
    assert "$npmCommand ci --prefix" in start
    assert "browser-observer" not in start.lower()
    assert "3099" not in start
    assert "http://127.0.0.1:3080" in start
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
    assert plugin["version"] == "1.0.7"
    assert "src/*.js" in plugin["files"]
    assert "security/*.py" in plugin["files"]
    assert "security/*.json" in plugin["files"]
    assert "assets/branding/favicon.svg" in plugin["files"]
    assert "@deepseek-ai/dsh-host-webserver" in plugin["peerDependencies"]
    assert not plugin.get("scripts"), "正式包不得声明未随包发布的测试/同步脚本"
    for peer in ("dsh-host-webserver", "dsh-llm", "dsh-tools"):
        assert plugin["peerDependencies"][f"@deepseek-ai/{peer}"] == "^0.1.0-rc.6"

    plugin_lock = json.loads(
        (ROOT / "dsh-clinical-data-guard" / "package-lock.json").read_text(encoding="utf-8")
    )
    assert plugin_lock["version"] == plugin["version"]
    assert plugin_lock["packages"][""]["version"] == plugin["version"]
    assert plugin_lock["packages"][""]["peerDependencies"] == plugin["peerDependencies"]

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
    assert "@deepseek-ai/dsh-mcp-client" not in profile["dependencies"]
    assert profile["dsh"]["profile"]["bundles"] == [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "emerald-clinical-data-guard",
    ]

    lock = (ROOT / ".dsh" / "profiles" / "clinical" / "pnpm-lock.yaml").read_text(encoding="utf-8")
    assert "link:../../../dsh-clinical-data-guard" in lock
    assert "G:/" not in lock and "C:/" not in lock

    assert not (ROOT / "browser-observer-mcp").exists()
    profile_patch = (ROOT / ".dsh" / "profiles" / "clinical" / "cordis.patch.yml").read_text(encoding="utf-8")
    assert "browser-observer" not in profile_patch.lower()
    assert "3099" not in profile_patch

    smoke = (
        ROOT / "dsh-clinical-data-guard" / "tests" / "e2e" / "installed_smoke.js"
    ).read_text(encoding="utf-8")
    assert "C:/Users" not in smoke
    assert "unexpected installed version" in smoke
    assert "unexpected inject contract" in smoke

    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    package_match = re.search(
        r"dsh-clinical-data-guard/(emerald-clinical-data-guard-[0-9.]+\.tgz)", readme)
    hash_match = re.search(r"SHA-256: `([0-9A-F]{64})`", readme)
    assert package_match and hash_match
    package_path = ROOT / "dsh-clinical-data-guard" / package_match.group(1)
    assert package_path.is_file()
    assert package_match.group(1) == f"emerald-clinical-data-guard-{plugin['version']}.tgz"
    actual_hash = hashlib.sha256(package_path.read_bytes()).hexdigest().upper()
    assert actual_hash == hash_match.group(1)

    required_members = {
        "package/package.json",
        "package/cordis.patch.yml",
        "package/src/index.js",
        "package/src/clinical-listing-plugin.js",
        "package/src/tool-result-guard.js",
        "package/security/worker.py",
        "package/security/smart_guard.py",
        "package/security/header_detect.py",
        "package/security/node_patterns.json",
    }
    with tarfile.open(package_path, "r:gz") as archive:
        members = {member.name for member in archive.getmembers() if member.isfile()}
        assert required_members <= members
        assert not any(
            part in {"tests", "scripts", "node_modules", "log", "var", "__pycache__"}
            for member in members
            for part in Path(member).parts
        )
        packaged_manifest = json.load(archive.extractfile("package/package.json"))
    assert packaged_manifest == plugin

    for path in (
        ROOT / "README.md",
        ROOT / "dsh-clinical-data-guard" / "README.md",
        ROOT / "docs" / "EMERALD_CLINICAL_MASTER_SPEC.md",
    ):
        text = path.read_text(encoding="utf-8")
        assert "C:\\Users" not in text
        assert "G:\\home" not in text
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
