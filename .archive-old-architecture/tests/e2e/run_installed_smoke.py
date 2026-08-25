from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = PLUGIN_ROOT.parent
SMOKE = Path(__file__).with_name("installed_smoke.js")


def npm_file_reference(path: Path) -> str:
    return f"file:{path.resolve().as_posix()}"


def main() -> int:
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if not npm:
        raise FileNotFoundError("npm executable is unavailable")

    plugin_manifest = json.loads((PLUGIN_ROOT / "package.json").read_text(encoding="utf-8"))
    package_basename = plugin_manifest["name"].removeprefix("@").replace("/", "-")
    package = PLUGIN_ROOT / f"{package_basename}-{plugin_manifest['version']}.tgz"
    runtime_modules = REPO_ROOT / "runtime" / "node_modules" / "@deepseek-ai"
    dependencies = {
        "@deepseek-ai/cordis": runtime_modules / "cordis",
        "@deepseek-ai/dsh-host-webserver": runtime_modules / "dsh-host-webserver",
        "@deepseek-ai/dsh-llm": runtime_modules / "dsh-llm",
        "@deepseek-ai/dsh-tools": runtime_modules / "dsh-tools",
        "emerald-clinical-data-guard": package,
    }
    for dependency in dependencies.values():
        if not dependency.exists():
            raise FileNotFoundError(f"installed smoke dependency is missing: {dependency}")

    with tempfile.TemporaryDirectory(prefix="dsh-guard-installed-") as directory:
        root = Path(directory)
        manifest = {
            "name": "dsh-guard-installed-smoke",
            "private": True,
            "type": "module",
            "dependencies": {
                name: npm_file_reference(dependency)
                for name, dependency in dependencies.items()
            },
        }
        (root / "package.json").write_text(
            json.dumps(manifest, ensure_ascii=True, indent=2) + "\n",
            encoding="utf-8",
        )
        env = os.environ.copy()
        env["npm_config_cache"] = str(REPO_ROOT / ".npm-cache")
        env["EMERALD_AUDIT_ROOT"] = str(root / "audit")
        env["PLUGIN_PYTHON"] = sys.executable
        install = subprocess.run(
            [npm, "install", "--ignore-scripts", "--no-audit", "--no-fund"],
            cwd=root,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
        )
        if install.returncode:
            print(install.stdout)
            print(install.stderr, file=sys.stderr)
            return install.returncode

        installed_entry = root / "node_modules" / "emerald-clinical-data-guard" / "src" / "index.js"
        env["INSTALLED_PLUGIN_URL"] = installed_entry.resolve().as_uri()
        smoke = subprocess.run(
            ["node", str(SMOKE)],
            cwd=root,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
        )
        if smoke.returncode:
            print(smoke.stderr, file=sys.stderr)
            return smoke.returncode
        result = json.loads(smoke.stdout)
        assert result == {
            "imported": True,
            "version": "1.0.7",
            "inject": ["tools", "llm", "webServer", "systemPrompt"],
            "streamed": True,
            "worker": "pong",
        }
        print("PASS installed-package-smoke")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
