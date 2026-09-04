"""数据拦截层：宿主开关控制的两类受保护数据值白名单投影。

开关默认开启；关闭时本层零处理。开启时红线为：
1. 数据集（sas7bdat/xpt/csv，含归档解出）的原始行值不出域。
2. doc/ 外 spec 需求辅助 Excel 的业务单元格值不出域；结构与 ALS 语义可出域。
3. 除上述两类数据值外，回执不做内容模式扫描或额外拦截。

宿主开关关闭时回执原样返回。开启时 ``_walk`` 递归投影带 ``_source``
标记且在 PROJECTION 表里的子树；
未命中子树对象恒等不动（一个字节不碰）。源头标记不进入 sandbox 命名空间，
模型不能重贴。没有 200 字预览、没有模式扫描。

设计文档：docs/enterprise/adr/0010-hard-data-boundary.md
"""
from datetime import datetime
from typing import Any, Optional

from source_registry import SOURCE_ATTR

#: 源头 → 投影白名单。改这里就是改整条数据红线。
PROJECTION: dict[str, tuple[str, ...]] = {
    "dataset": ("name", "path", "columns", "rowCount", "dtypes", "nullCount", "uniqueCount"),
    "aux-excel": ("path", "type", "size", "structure", "mappings", "datasets"),
}

#: 场景①白名单（数据集 → 元数据）。
DATASET_KEYS = PROJECTION["dataset"]
#: 场景②白名单（doc 外辅助 Excel → 结构与 ALS 语义，不含业务数据行）。
AUX_EXCEL_KEYS = PROJECTION["aux-excel"]


def project_payload(payload: dict) -> dict:
    """按源头投影白名单；不在表里的标记原样返回（None 语义由调用方处理）。"""
    keys = PROJECTION.get(payload.get(SOURCE_ATTR, ""))
    if keys is None:
        return payload
    projected = {key: payload[key] for key in keys if key in payload}
    projected[SOURCE_ATTR] = payload[SOURCE_ATTR]   # 保留标记，回执可追溯被投影过
    return projected


def _walk(value: Any, audit: Optional[list] = None) -> Any:
    """递归投影；未命中子树原样返回（对象恒等，零改动）。"""
    if isinstance(value, dict):
        if value.get(SOURCE_ATTR, "") in PROJECTION:
            if audit is not None:
                audit.append({
                    "source": value[SOURCE_ATTR],
                    "path": value.get("path"),
                })
            return project_payload(value)
        result = value
        for key, item in value.items():
            if key == SOURCE_ATTR:
                continue
            walked = _walk(item, audit)
            if walked is not item and result is value:
                result = {k: v for k, v in value.items() if k != SOURCE_ATTR}
                result[key] = walked
            elif walked is not item:
                result[key] = walked
        return result
    if isinstance(value, list):
        result = value
        for index, item in enumerate(value):
            walked = _walk(item, audit)
            if walked is not item and result is value:
                result = list(value)
                result[index] = walked
            elif walked is not item:
                result[index] = walked
        return result
    return value


def sanitize_receipt(
    receipt: dict, data_interception: bool = True, audit: Optional[list] = None,
) -> dict:
    """统一拦截入口；宿主关闭时不做任何处理。"""
    if not data_interception:
        return receipt
    return _walk(receipt, audit)


def audit_record(
    operation: str, projections: list, data_interception: bool = True,
) -> Optional[dict]:
    """构造一行审计记录（无任何数据值）；无投影发生时返回 None。"""
    if not projections:
        return None
    return {
        "time": datetime.now().isoformat(),
        "operation": operation,
        "dataInterception": data_interception,
        "projections": projections,
    }
