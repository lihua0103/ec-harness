"""兼容层：拦截已重写为 ``data_guard``（2026-08-28 两规则口径）。

旧名仅作转发，新代码请 import ``data_guard``。Windows 侧可直接删除本文件
（G: 挂载沙箱无法 unlink，故以 shim 形式退役）。
"""
from data_guard import (  # noqa: F401
    AUX_EXCEL_KEYS,
    DATASET_KEYS,
    PROJECTION,
    audit_record,
    project_payload,
    sanitize_receipt,
)

#: 旧名映射：V2 时期的 METADATA_KEYS/STRUCTURE_KEYS 语义分别由
#: DATASET_KEYS / AUX_EXCEL_KEYS 承担。
METADATA_KEYS = DATASET_KEYS
STRUCTURE_KEYS = AUX_EXCEL_KEYS

__all__ = [
    "AUX_EXCEL_KEYS",
    "DATASET_KEYS",
    "METADATA_KEYS",
    "STRUCTURE_KEYS",
    "PROJECTION",
    "audit_record",
    "project_payload",
    "sanitize_receipt",
]
