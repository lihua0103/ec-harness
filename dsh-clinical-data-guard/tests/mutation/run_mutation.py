from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PYTHON = sys.executable


@dataclass(frozen=True)
class Mutant:
    name: str
    file: str
    old: str
    new: str


MUTANTS = (
    Mutant("egress-blocking", "egress_checkpoint.py", "if blocking_threats:", "if False:"),
    Mutant(
        "full-request-scope",
        "egress_checkpoint.py",
        "threats = self.recognizer.scan_structured(payload, path=\"payload\")",
        "threats = self.recognizer.scan_structured(payload if not isinstance(payload, dict) else payload.get(\"messages\", []), path=\"payload\")",
    ),
    # FIX-11 (NFR-2): base64 最小长度门槛——跳过全部候选时 BY-1 必漏。
    Mutant("base64-min-length", "egress_checkpoint.py",
           "if len(token) < 24:", "if len(token) >= 24:"),
    # FIX-2 (R-7/FR-09-03): 任意键名扫描——绕过时敏感键名漏检。
    Mutant("key-name-scan", "egress_checkpoint.py",
           "for threat in self.scan_text(key_str, child_path):",
           "for threat in []:"),
    Mutant("unicode-bypass", "egress_checkpoint.py", "if normalized != text:", "if False:"),
    Mutant("sas-extension", "ai_operations_monitor.py",
           r"(re.compile(r'\.sas7bdat', re.IGNORECASE), RiskLevel.HIGH,",
           r"(re.compile(r'\.sasXbdat', re.IGNORECASE), RiskLevel.HIGH,"),
    Mutant("pickle-alias", "ai_operations_monitor.py",
           'RiskLevel.CRITICAL, "尝试用别名导入',
           'RiskLevel.LOW, "尝试用别名导入'),
    Mutant("sensitive-combination", "data_egress_guard.py",
           "if subj_count >= 1 and date_count >= 1 and medical_count >= 1:", "if False:"),
    Mutant("light-subject-scrub", "data_egress_guard.py",
           r"s = token_sub(re.compile(r'\b[A-Z]{1,4}\d{6,8}\b', re.IGNORECASE), s, 'SUBJ')", "s = s"),
    Mutant("filename-exemption", "patterns.py", "return True", "return False"),
)


def run_oracle(cwd: Path) -> bool:
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    result = subprocess.run(
        [PYTHON, str(ROOT / "tests" / "mutation" / "oracle.py")],
        cwd=cwd,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=20,
    )
    return result.returncode == 0


def evaluate(mutant: Mutant) -> bool:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        shutil.copytree(ROOT / "security", root / "security",
                        ignore=shutil.ignore_patterns("__pycache__"))
        target = root / "security" / mutant.file
        text = target.read_text(encoding="utf-8")
        if text.count(mutant.old) != 1:
            raise RuntimeError(f"mutation anchor is not unique: {mutant.name}")
        target.write_text(text.replace(mutant.old, mutant.new), encoding="utf-8")
        return not run_oracle(root)


def main() -> int:
    if not run_oracle(ROOT):
        print("FAIL baseline oracle")
        return 1
    results = [(mutant.name, evaluate(mutant)) for mutant in MUTANTS]
    for name, killed in results:
        print(f"{'KILLED' if killed else 'SURVIVED'} {name}")
    killed = sum(value for _, value in results)
    score = killed / len(results) * 100
    print(f"RESULT {killed}/{len(results)} ({score:.2f}%)")
    return 0 if score >= 95 else 1


if __name__ == "__main__":
    sys.exit(main())
