"""pytest 根配置：架构迁移后的路径常量 + 临时目录治理。

2026-08-25 架构迁移：Python 运行时从插件根目录移入 `python/` 子目录
（`security/`、`assets/`、JS 桥接 `src/` 均已下移），但测试文件原先沿用
旧布局的 `ROOT = parents[2]` 基准，导致 `ROOT / "security"` 等路径失效。

导出的路径常量（测试应优先使用这些，而非自行推导）：

    PLUGIN_ROOT   插件根（含 package.json、tests/、excel_header_extractor.py）
    PYTHON_ROOT   Python 运行时根（含 security/、assets/、src/ JS 桥接）
    SECURITY_DIR  Python 安全模块目录
    BRIDGE_DIR    JavaScript 桥接目录（index.js / branding.js 等）
    ASSETS_DIR    品牌资源目录
    VAR_DIR       运行期可变数据目录
"""
from __future__ import annotations

import gc
import os
import sys
import tempfile
import time
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent
PYTHON_ROOT = PLUGIN_ROOT / "python"
SECURITY_DIR = PYTHON_ROOT / "security"
BRIDGE_DIR = PYTHON_ROOT / "src"
ASSETS_DIR = PYTHON_ROOT / "assets"
VAR_DIR = PYTHON_ROOT / "var"

# 让 `import security.xxx` 独立于外部 PYTHONPATH 设置
if str(PYTHON_ROOT) not in sys.path:
    sys.path.insert(0, str(PYTHON_ROOT))


# ---------------------------------------------------------------------------
# 临时目录治理
#
# 系统（含测试）不往用户 C 盘写任何数据。Python tempfile 默认跟随 TEMP/TMP
# （Windows 下为 C:\Users\...\AppData\Local\Temp），测试中的
# TemporaryDirectory/mkdtemp 会全部落在 C 盘。此处把临时区统一定到插件内的
# .cache/tmp，与运行时（path_policy.system_temp_root / index.js worker env）
# 保持同一位置。
#
# 注意：这段逻辑与 python/conftest.py 等价。两者不可同时生效——cleanup 补丁
# 若被重复应用会自我包裹并导致 RecursionError。因此这里用 _PATCH_FLAG 做幂等
# 保护，无论 pytest 从哪个 rootdir 收集 conftest 都只打一次补丁。
# ---------------------------------------------------------------------------
_TMP_ROOT = PLUGIN_ROOT / ".cache" / "tmp"
_TMP_ROOT.mkdir(parents=True, exist_ok=True)

os.environ["EMERALD_TMP_ROOT"] = str(_TMP_ROOT)
os.environ["TMPDIR"] = str(_TMP_ROOT)
os.environ["TEMP"] = str(_TMP_ROOT)
os.environ["TMP"] = str(_TMP_ROOT)
tempfile.tempdir = str(_TMP_ROOT)

_PATCH_FLAG = "_dsh_guard_gc_tolerant_cleanup"

if not getattr(tempfile.TemporaryDirectory.cleanup, _PATCH_FLAG, False):
    _original_cleanup = tempfile.TemporaryDirectory.cleanup

    def _gc_tolerant_cleanup(self) -> None:
        """Windows 清理容忍。

        openpyxl read_only 的 iter_rows 解析器与 workbook/archive 存在引用环，
        文件句柄需等 gc 才释放；杀毒/索引对新建 xlsx（zip 容器）也有毫秒级扫描锁。
        直接 rmtree 会撞 WinError 32。此处在 cleanup 前打断引用环并短重试；
        持续锁定仍抛错，不掩盖真实的句柄泄漏。
        """
        gc.collect()
        for attempt in range(5):
            try:
                _original_cleanup(self)
                return
            except PermissionError:
                if attempt == 4:
                    raise
                gc.collect()
                time.sleep(0.3)

    setattr(_gc_tolerant_cleanup, _PATCH_FLAG, True)
    tempfile.TemporaryDirectory.cleanup = _gc_tolerant_cleanup
