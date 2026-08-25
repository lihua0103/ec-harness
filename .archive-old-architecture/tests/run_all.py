from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TARGETS = [
    ROOT / "tests" / "unit" / "test_code_sandbox.py",
    ROOT / "tests" / "unit" / "test_listing_code_lane.py",
    ROOT / "tests" / "unit" / "test_listing_security.py",
    ROOT / "tests" / "unit" / "test_listing_plan_contract.py",
    ROOT / "tests" / "unit" / "test_listing_e2e_fixes.py",
    ROOT / "tests" / "unit" / "test_security.py",
    ROOT / "tests" / "unit" / "test_egress_v2_fix.py",
    ROOT / "tests" / "integration" / "test_plugin_runtime.py",
    ROOT / "tests" / "integration" / "test_runtime_resilience.py",
    ROOT / "tests" / "integration" / "test_branding.py",
    ROOT / "tests" / "integration" / "test_plugin_contract.py",
    ROOT / "tests" / "e2e" / "run_installed_smoke.py",
    ROOT / "tests" / "bypass" / "test_bypass_matrix.py",
]

# Node 侧套件（模型出域结果投影与运行态策略只在 JS 车道，Python 测不到）。
# 2026-08-25 修复：data_interception_policy_cases.mjs 此前存在却未登记，
# 出域开关的运行态策略（含 onSwitch 重启回调）从未在 run_all 下执行过。
NODE_TARGETS = [
    ROOT / "tests" / "unit" / "planes_cases.mjs",
    ROOT / "tests" / "unit" / "data_interception_policy_cases.mjs",
]


def main() -> int:
    os.chdir(ROOT)
    # 与 conftest.py 同一约定：测试临时区统一定到系统目录 .cache/tmp，绝不写
    # C 盘用户临时区。standalone 子进程不加载 conftest，若不在此对齐，测试的
    # TemporaryDirectory 落 C: 而发布 staging 固定在 G:（system_temp_root），
    # 跨卷 rename 在部分 Windows 环境抛 WinError 5（而非回退分支识别的 17），
    # 发布路径用例（F-7）在 run_all 下稳定失败、pytest 下全绿。
    tmp_root = ROOT.parent / ".cache" / "tmp"
    tmp_root.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    for key in ("EMERALD_TMP_ROOT", "TMPDIR", "TEMP", "TMP"):
        env[key] = str(tmp_root)
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    failed = 0
    for target in TARGETS:
        print(f"\n=== {target.relative_to(ROOT)} ===")
        result = subprocess.run([sys.executable, str(target)], cwd=ROOT, env=env)
        failed += 1 if result.returncode else 0
    for target in NODE_TARGETS:
        print(f"\n=== {target.relative_to(ROOT)} ===")
        result = subprocess.run(["node", str(target)], cwd=ROOT, env=env)
        failed += 1 if result.returncode else 0
    print(f"\nTOTAL_FAILED_SUITES={failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
