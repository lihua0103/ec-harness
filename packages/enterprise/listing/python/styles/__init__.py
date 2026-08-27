"""styles/__init__.py - 样式模块导出"""
from .style_spec import (
    get_style_spec,
    get_system_fields,
    is_system_field,
    SCENARIO_STYLES,
    SYSTEM_FIELDS
)

from .formatter import (
    format_workbook,
    format_contents_sheet,
    format_data_sheet
)

from .multi_sheet_writer import (
    create_multi_sheet_excel,
    merge_listing_files,
    generate_contents_page,
    calculate_changes
)

__all__ = [
    # 样式规范
    'get_style_spec',
    'get_system_fields',
    'is_system_field',
    'SCENARIO_STYLES',
    'SYSTEM_FIELDS',
    
    # 格式化器
    'format_workbook',
    'format_contents_sheet',
    'format_data_sheet',
    
    # 多 sheet 写入器
    'create_multi_sheet_excel',
    'merge_listing_files',
    'generate_contents_page',
    'calculate_changes',
]
