"""与 EDC 命名无关的 ALS 设计表推断（2026-09-07）。

背景：真实交付里 ALS 至少有三种形态（Medidata Rave、太美、ODM-DED 中文），
按表头签名识别（discovery._DESIGN_SHEET_SIGNATURES）只能覆盖已见过的系统；
新 EDC 一来就退回"0 映射 + 整张设计表当业务值灌入保护索引"——模型拿不到
表单字段语义，通用工具结果里凡是提到表单名/字段标签就被误拦。

本模块不看列名、不看 sheet 名，只看**值与 SAS 数据集结构的关系**：

* 正向：设计表定义的就是导出数据集的结构，所以它至少有一列的值绝大多数
  等于数据集**列名**或**数据集名**（变量 OID / 表单 OID）。
* 负向（任一命中即判业务表，优先于正向）：
  - 有一列的值大量落在数据集**高基数列的行值**里（受试者号、实例 ID、
    自由文本——按列基数识别，不按名字；集合宁大勿小，只用于否决）；
  - 有一列被**日期**占据（质疑/审计/页面状态导出必带时间列，设计表没有）；
  - 行数远超全项目变量总数（14605 行的 Query_Details 不可能是设计表）。

推断结果是保守的：数据集未加载时不做任何推断（只信适配器）。否决集合只
用来让更多 sheet 被判为业务表（多保护），从不用于放行任何值。

推断成功的 sheet 会把表头形态/列角色登记到 edc_profiles（学习型注册表），
让同一 EDC 的后续项目在 discovery 层直接按适配器命中。
"""
import re
from typing import Any, Optional

import pandas as pd

MIN_EVIDENCE_CELLS = 5
STRUCTURAL_COLUMN_RATIO = 0.6
SUBJECT_KEY_COLUMN_RATIO = 0.2
DATE_COLUMN_RATIO = 0.5
KEY_COLUMN_CARDINALITY = 0.3
KEY_COLUMN_MIN_UNIQUE = 10
DESIGN_ROWS_PER_VOCAB = 3

_TRIVIAL = frozenset({"", "nan", "none", "null", "true", "false", "y", "n", "x", "yes", "no"})
_DATE_PATTERN = re.compile(
    r"^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/ ]?[A-Za-z]{3}[-/ ]?\d{2,4}|\d{4}年\d{1,2}月\d{1,2}日)"
    r"([ T]\d{1,2}:\d{2}(:\d{2})?)?$")


def _text(value: Any) -> str:
    if value is None:
        return ""
    try:
        if pd.isna(value):
            return ""
    except (TypeError, ValueError):
        pass
    text = str(value).strip()
    return "" if text.lower() in _TRIVIAL else text


def structural_vocabulary(datasets: dict[str, pd.DataFrame]) -> set[str]:
    """数据集列名 + 数据集名（大写形态）。"""
    vocabulary = {str(name).strip().upper() for name in datasets}
    for frame in datasets.values():
        vocabulary.update(str(column).strip().upper() for column in frame.columns)
    return {item for item in vocabulary if len(item) >= 2}


def column_owners(datasets: dict[str, pd.DataFrame]) -> dict[str, list[str]]:
    owners: dict[str, set[str]] = {}
    for name, frame in datasets.items():
        for column in frame.columns:
            owners.setdefault(str(column).strip().upper(), set()).add(str(name).upper())
    return {column: sorted(names) for column, names in owners.items()}


def row_identifier_values(datasets: dict[str, pd.DataFrame]) -> set[str]:
    """数据集高基数列的全部行值（受试者号、实例 ID、自由文本…）。

    只作设计表推断的否决集合：一个 sheet 的某列大量落在这里面，它就是受试者
    级业务导出。集合宁大勿小（误含 VISIT 之类只会让更多表被保护），因此
    不按列名、不要求列在多数数据集里出现，只看列内基数。
    """
    values: set[str] = set()
    for frame in datasets.values():
        if len(frame) == 0:
            continue
        for column in frame.columns:
            series = frame[column].dropna()
            unique = series.nunique()
            if unique < KEY_COLUMN_MIN_UNIQUE or unique / max(len(series), 1) < KEY_COLUMN_CARDINALITY:
                continue
            values.update(_text(v) for v in series.unique().tolist())
    values.discard("")
    return values


def _columns(rows: list[Any]) -> list[list[str]]:
    width = max((len(row) for row in rows if isinstance(row, list)), default=0)
    columns: list[list[str]] = [[] for _ in range(width)]
    for row in rows:
        if not isinstance(row, list):
            continue
        for index, value in enumerate(row):
            text = _text(value)
            if text:
                columns[index].append(text)
    return columns


def _ratio(values: list[str], predicate) -> float:
    """去重后的命中比例：变量/主键/日期列的证据要看不同的值有多少。"""
    distinct = set(values)
    if len(distinct) < MIN_EVIDENCE_CELLS:
        return 0.0
    return sum(1 for value in distinct if predicate(value)) / len(distinct)


def _coverage(values: list[str], predicate) -> float:
    """逐格命中比例：数据集列天然低基数（一个项目只有几十个数据集名反复
    出现），按去重评分永远不够证据，按格计数才能识别。"""
    if len(values) < MIN_EVIDENCE_CELLS:
        return 0.0
    return sum(1 for value in values if predicate(value)) / len(values)


def is_design_sheet(
    rows: list[Any], vocabulary: set[str], row_values: set[str],
) -> bool:
    """名字无关的设计表判定；任一负向条件命中即 False。"""
    if not vocabulary or not rows:
        return False
    if len(rows) > DESIGN_ROWS_PER_VOCAB * max(len(vocabulary), MIN_EVIDENCE_CELLS):
        return False
    structural = False
    for values in _columns(rows):
        if _ratio(values, lambda v: v in row_values) >= SUBJECT_KEY_COLUMN_RATIO:
            return False
        if _ratio(values, lambda v: bool(_DATE_PATTERN.match(v))) >= DATE_COLUMN_RATIO:
            return False
        if _ratio(values, lambda v: v.upper() in vocabulary) >= STRUCTURAL_COLUMN_RATIO:
            structural = True
    return structural


def _infer(
    rows: list[Any], datasets: dict[str, pd.DataFrame],
) -> tuple[list[dict[str, str]], dict[str, int]]:
    """推断映射及列角色下标（dataset/variable/label → 列号）。

    变量列 = 值最贴合数据集列名的列；数据集列 = 值最贴合数据集名的列（缺失
    时取包含该变量的首个数据集）；label = 同行里最长的非结构、非数字文本，
    角色下标取被选中次数最多的列。
    """
    owners = column_owners(datasets)
    dataset_names = {str(name).upper() for name in datasets}
    columns = _columns(rows)
    if not columns:
        return [], {}
    variable_scores = [_ratio(values, lambda v: v.upper() in owners) for values in columns]
    dataset_scores = [_coverage(values, lambda v: v.upper() in dataset_names) for values in columns]
    variable_index = max(range(len(columns)), key=variable_scores.__getitem__)
    if variable_scores[variable_index] < STRUCTURAL_COLUMN_RATIO:
        return [], {}
    dataset_index = max(range(len(columns)), key=dataset_scores.__getitem__)
    if dataset_scores[dataset_index] < STRUCTURAL_COLUMN_RATIO or dataset_index == variable_index:
        dataset_index = -1
    mappings: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    label_votes: dict[int, int] = {}
    for row in rows:
        if not isinstance(row, list) or len(row) <= variable_index:
            continue
        variable = _text(row[variable_index])
        if variable.upper() not in owners:
            continue
        dataset = ""
        if dataset_index >= 0 and len(row) > dataset_index:
            dataset = _text(row[dataset_index]).upper()
        if dataset not in dataset_names:
            dataset = owners[variable.upper()][0]
        label, label_index = "", -1
        for index, value in enumerate(row):
            if index in (variable_index, dataset_index):
                continue
            text = _text(value)
            if (len(text) > len(label) and text.upper() not in owners and text.upper() not in dataset_names
                    and not any(ch.isdigit() for ch in text)):
                label, label_index = text, index
        if label_index >= 0:
            label_votes[label_index] = label_votes.get(label_index, 0) + 1
        key = (dataset, variable)
        if key in seen:
            continue
        seen.add(key)
        mappings.append({"datasetName": dataset, "sourceColumn": variable, "label": label})
    roles = {"variable": variable_index}
    if dataset_index >= 0:
        roles["dataset"] = dataset_index
    if label_votes:
        roles["label"] = max(label_votes, key=label_votes.__getitem__)
    return mappings, roles


def infer_mappings(
    rows: list[Any], datasets: dict[str, pd.DataFrame],
) -> list[dict[str, str]]:
    """从已判定的设计 sheet 推断 datasetName/sourceColumn/label 三元组。"""
    return _infer(rows, datasets)[0]


def _sheet_headers(document: dict[str, Any], sheet_name: str) -> list[str]:
    for sheet in (document.get("structure") or {}).get("sheets") or []:
        if isinstance(sheet, dict) and str(sheet.get("name")) == sheet_name:
            header_rows = sheet.get("headerRows") or []
            if header_rows and isinstance(header_rows[0], list):
                return [str(header) for header in header_rows[0]]
    return []


def enrich_design_semantics(
    datasets: dict[str, pd.DataFrame], auxiliary: list[dict[str, Any]],
    learn: bool = True,
) -> None:
    """就地补全辅助文档的 designSheets / mappings。

    适配器（手写或已学习）识别的 sheet 保留；未识别的 sheet 按结构推断，记入
    inferredDesignSheets 供回执披露。推断成功且 ``learn`` 为真时，把该 sheet
    的表头形态与列角色登记到学习型注册表（edc_profiles），下次同一 EDC 的导出
    在 discovery 层即可按适配器识别；登记结果记入 learnedEdcProfiles。
    文档缺 mappings 时，从全部设计 sheet（含适配器识别但只有 designSheets 的）
    推断映射。
    """
    if not datasets:
        return
    vocabulary = structural_vocabulary(datasets)
    row_values = row_identifier_values(datasets)
    for document in auxiliary:
        known = set(document.get("designSheets") or [])
        inferred: list[str] = []
        learned: list[str] = []
        candidate_mappings: list[dict[str, str]] = []
        for sheet in document.get("rows") or []:
            if not isinstance(sheet, dict):
                continue
            name = str(sheet.get("sheet"))
            rows = sheet.get("rows") or []
            if name in known:
                if not document.get("mappings"):
                    candidate_mappings.extend(infer_mappings(rows, datasets))
                continue
            if not is_design_sheet(rows, vocabulary, row_values):
                continue
            inferred.append(name)
            mappings, roles = _infer(rows, datasets)
            if not document.get("mappings"):
                candidate_mappings.extend(mappings)
            if learn:
                headers = _sheet_headers(document, name)
                role_headers = {role: headers[index] for role, index in roles.items()
                                if 0 <= index < len(headers)}
                profile = _learn(name, headers, role_headers)
                if profile is not None:
                    learned.append(profile["id"])
        if inferred:
            document["designSheets"] = sorted(known | set(inferred))
            document["inferredDesignSheets"] = sorted(inferred)
        if learned:
            document["learnedEdcProfiles"] = sorted(set(learned))
        if candidate_mappings and not document.get("mappings"):
            document["mappings"] = candidate_mappings
            document["datasets"] = sorted({m["datasetName"] for m in candidate_mappings})
            document["type"] = "als"


def _learn(sheet_name: str, headers: list[str], roles: dict[str, str]) -> Optional[dict[str, Any]]:
    """学习失败（只读部署/文件损坏）只降级为"本次不学习"，绝不打断 inspect。"""
    try:
        from edc_profiles import learn_profile
        return learn_profile(sheet_name, headers, roles)
    except Exception as exc:  # noqa: BLE001
        import sys
        sys.stderr.write(f"[enterprise-listing] edc profile learning skipped: {exc}\n")
        return None