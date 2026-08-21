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

    entry = (ROOT / "src" / "index.js").read_text(encoding="utf-8")
    assert "export default function clinicalDataGuard" in entry
    assert "clinicalDataGuard.inject = ['tools', 'llm', 'webServer'];" in entry
    for extension in (
        "ctx.tools.guard",
        "'tools/pre-execute'",
        "'tools/post-execute'",
        "'llm/stream'",
        "registerBranding",
        "modelRequestPayload",
        "registerLocalMetadataTool",
        "localDataAccess",
    ):
        assert extension in entry

    assert (ROOT / "security" / "worker.py").is_file()
    assert (ROOT / "security" / "local_data_inspector.py").is_file()
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
