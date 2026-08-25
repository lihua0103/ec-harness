from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_plugin_contract():
    manifest = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    assert manifest["type"] == "module"
    assert manifest["main"] == "src/index.js"
    assert manifest["exports"]["."] == "./src/index.js"
    assert manifest["dsh"]["bundle"]["patch"] == "./cordis.patch.yml"
    assert not manifest.get("dependencies")
    assert {
        "@deepseek-ai/cordis",
        "@deepseek-ai/dsh-llm",
        "@deepseek-ai/dsh-tools",
        "@deepseek-ai/dsh-host-webserver",
    } <= set(manifest["peerDependencies"])
    assert "assets/branding/favicon.svg" in manifest["files"]

    patch = (ROOT / "cordis.patch.yml").read_text(encoding="utf-8")
    assert "id: clinical-data-guard" in patch
    assert "name: emerald-clinical-data-guard" in patch
    assert "localDataAccess: uat-local" in patch
    # F-11: 旧生成器车道已下线，配置不得再声明可插拔生成器模块。
    assert "listingGenerator" not in patch

    entry = (ROOT / "src" / "index.js").read_text(encoding="utf-8")
    assert "export default function clinicalDataGuard" in entry
    assert "clinicalDataGuard.inject = ['tools', 'llm', 'webServer', 'systemPrompt'];" in entry
    for extension in (
        "'tools/post-execute'",
        "'llm/stream'",
        "registerBranding",
        "modelRequestPayload",
        "registerLocalMetadataTool",
        "localDataAccess",
    ):
        assert extension in entry
    for obsolete in (
        "listingEngineRoot",
        "EMERALD_LISTING_ENGINE_ROOT",
        "emerald_clinical_listing",
        "ctx.tools.guard",
        "'tools/pre-execute'",
        "requestL3Decision",
        "needsApproval",
        "authorizationRoot",
        "DATA_PROTECTION_MODE",
    ):
        assert obsolete not in entry

    worker = (ROOT / "security" / "worker.py").read_text(encoding="utf-8")
    assert 'raw_scenario = request.get("scenario")' in worker
    assert 'scenario = str(raw_scenario) if raw_scenario else None' in worker

    assert (ROOT / "security" / "worker.py").is_file()
    assert (ROOT / "security" / "local_data_inspector.py").is_file()
    assert not (ROOT / "security" / "demo_replica.py").exists()
    assert not (ROOT / "security" / "manifest_reader.py").exists()
    assert "build_demo_replica" not in entry
    assert "demoDataLane" not in entry
    assert (ROOT / "src" / "branding.js").is_file()
    assert (ROOT / "assets" / "branding" / "favicon.svg").is_file()
    assert not (ROOT / "proxy.js").exists()
    assert not (ROOT / "security-checkpoint.js").exists()


def main() -> int:
    try:
        test_plugin_contract()
        print("PASS plugin-standard-contract")
        print("RESULT 1/1")
        return 0
    except Exception as error:
        print(f"FAIL plugin-standard-contract: {error}")
        print("RESULT 0/1")
        return 1


if __name__ == "__main__":
    sys.exit(main())
