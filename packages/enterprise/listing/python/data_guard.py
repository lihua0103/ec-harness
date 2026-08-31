"""数据拦截层：单规则投影 + 宿主侧开关（2026-08-28 第三版口径，ADR-0007）。

需求原文（效力高于 V2 文档与 ADR-0006 场景②表述）：
1. **doc/ 文件夹零拦截**——所有文本与 Excel 辅助表全量读、全量回执，
   不投影、不截断（截断上限只作协议护栏，且必须显式标记 truncated）。
2. 拦截**只剩一种场景**：数据集（sas7bdat/xpt/csv）的原始行值不出域
   （→ 元数据白名单 name/path/columns/rowCount/dtypes/nullCount/uniqueCount）。
3. 开关默认开；关闭时零拦截（回执原样）。开关由宿主（DataSecurityService
   设置页 + tool-audit 通用车道护栏）执行，模型永远接触不到。

机制：``_walk`` 递归投影带 ``_source`` 标记且在 PROJECTION 表里的子树；
未命中子树对象恒等不动（一个字节不碰）。没有 200 字预览、没有模式扫描。

设计文档：docs/enterprise/adr/0007-dataset-only-redline-and-lane-guard.md
"""
from datetime import datetime
from typing import Any, Optional

from source_registry import SOURCE_ATTR

#: 源头 → 投影白名单。改这里就是改整条数据红线（只剩一条，按需求）。
#: ``profile``（2026-08-30 系统级重构）：列级语义画像——值形态类/格式
#: 模式骨架/派生计数，不含真实值；是"零瞎"供给（AI 不看行值也能判格式
#: 生成解析代码），故与列名/dtype 同级放行。
PROJECTION: dict[str, tuple[str, ...]] = {
    "dataset": ("name", "path", "columns", "rowCount", "dtypes",
                "nullCount", "uniqueCount", "profile"),
}

#: 场景①白名单（数据集 → 元数据）。
DATASET_KEYS = PROJECTION["dataset"]
#: 兼容别名：场景②（aux-excel）已于 2026-08-28 退役——doc/ 零拦截。
#: 退役 shim redact.py 仍引用本名，恒为空元组（不在投影表 = 不拦截）。
AUX_EXCEL_KEYS: tuple[str, ...] = ()


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
    receipt: dict, data_interception: bool, audit: Optional[list] = None,
) -> dict:
    """统一拦截入口。

    - ``data_interception`` 为假（宿主开关关闭）→ 原样返回，零处理。
    - 为真 → 只投影 dataset 载荷；doc/ 文本与辅助 Excel（spec-document /
      aux-excel 标记）不在投影表 = 恒等直通。若传入 ``audit`` 列表，
      逐条记录被投影载荷的 source 与 path（无数据值），供 worker 落审计。
    """
    if not data_interception:
        return receipt
    return _walk(receipt, audit)


def audit_record(
    operation: str, enabled: bool, projections: list, masked_count: int = 0,
) -> Optional[dict]:
    """构造一行审计记录（无任何数据值）；无投影且无遮蔽时返回 None。

    ``masked_count`` 是 FR-8 值遮蔽的纯计数（[DATA] 替换次数），不含值内容。
    """
    if not projections and not masked_count:
        return None
    return {
        "time": datetime.now().isoformat(),
        "operation": operation,
        "dataInterception": enabled,
        "projections": projections,
        "maskedCount": masked_count,
    }
