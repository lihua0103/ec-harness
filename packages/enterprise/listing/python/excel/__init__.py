"""临床 Listing Excel 输出层。

- style_atoms  : 样式常量（颜色/字体/边框/行高列宽）——输出标准
- templates    : 固定模板（Content Sheet / Cover Page / ALS 审核列），可跳过
- layout       : df.attrs["_layout"] 自定义排版（横/纵/多层表头/锚点）
- build_workbook : 唯一入口 create_multi_sheet_excel
"""
from .build_workbook import (
    build_custom_sheet,
    build_listing_sheet,
    build_report_sheet,
    calculate_changes,
    create_multi_sheet_excel,
    load_previous_version,
    normalize_sheet_outputs,
)
from .layout import LAYOUT_ATTR, Layout, read_layout
from .templates import (
    COMPARISON_COLUMNS,
    COMPARISON_LABELS,
    CONTENT_COLUMNS,
    CONTENT_SHEET,
    CONTENT_TITLE,
    REPORT_COVER_SHEET,
    SKIP_TEMPLATE_ATTR,
    STANDARD_SCENARIOS,
    SUPPORTED_SCENARIOS,
    apply_default_template,
)

__all__ = [
    "COMPARISON_COLUMNS",
    "COMPARISON_LABELS",
    "CONTENT_COLUMNS",
    "CONTENT_SHEET",
    "CONTENT_TITLE",
    "LAYOUT_ATTR",
    "Layout",
    "REPORT_COVER_SHEET",
    "SKIP_TEMPLATE_ATTR",
    "STANDARD_SCENARIOS",
    "SUPPORTED_SCENARIOS",
    "apply_default_template",
    "build_custom_sheet",
    "build_listing_sheet",
    "build_report_sheet",
    "calculate_changes",
    "create_multi_sheet_excel",
    "load_previous_version",
    "normalize_sheet_outputs",
    "read_layout",
]
