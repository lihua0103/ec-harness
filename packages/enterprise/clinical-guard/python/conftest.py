"""pytest 全局：临时文件只允许落在系统项目内，绝不写 C 盘用户临时区。

2026-08-24：系统（含测试）不往 C 盘写任何数据。Python tempfile 默认跟随
TEMP/TMP（C:\\Users\\...\\AppData\\Local\\Temp），测试里的 TemporaryDirectory/
mkdtemp 此前全部落在 C 盘。会话启动时把临时区统一定到系统目录 .cache/tmp，
与运行时（path_policy.system_temp_root / index.js worker env）同一位置。
"""
from __future__ import annotations

import gc
import os
import tempfile
import time
from pathlib import Path

_TMP_ROOT = Path(__file__).resolve().parents[1] / ".cache" / "tmp"
_TMP_ROOT.mkdir(parents=True, exist_ok=True)

os.environ["EMERALD_TMP_ROOT"] = str(_TMP_ROOT)
os.environ["TMPDIR"] = str(_TMP_ROOT)
os.environ["TEMP"] = str(_TMP_ROOT)
os.environ["TMP"] = str(_TMP_ROOT)
tempfile.tempdir = str(_TMP_ROOT)

# Windows 清理容忍：openpyxl read_only 的 iter_rows 解析器与 workbook/archive
# 存在引用环，文件句柄要等 gc 才释放；杀毒/索引对新建 xlsx（zip 容器）也有
# 毫秒级扫描锁。直接 rmtree 必撞 WinError 32。统一在 TemporaryDirectory.cleanup
# 前打断引用环并短重试；持续锁定仍报错，不掩盖真实句柄泄漏。
#
# 幂等保护：插件根的 conftest.py 有等价逻辑。若两者都生效，补丁会自我包裹并
# 导致 RecursionError，因此用标记位确保只打一次。
_PATCH_FLAG = "_dsh_guard_gc_tolerant_cleanup"

if not getattr(tempfile.TemporaryDirectory.cleanup, _PATCH_FLAG, False):
    _original_cleanup = tempfile.TemporaryDirectory.cleanup

    def _gc_tolerant_cleanup(self) -> None:
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
