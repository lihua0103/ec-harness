"""受控分析操作（方案 §6，T06）：固定操作注册表 + 结构化参数 + 只释放计数。

可信边界（§6.4）：本模块运行在宿主 worker 进程，**不执行模型代码**；
输入句柄只能是已登记的会话数据集名或最近一次成功 run_code 的产物名——
模型不能传文件路径，也不能传表达式/callback/SQL。全部返回值为有限非负
整数计数（§6.2），不含行值、键值、原始去重值或自由文本。

RELEASE_POLICY_V1（§6.3）：输入质量/覆盖/结构/比对类计数默认可释放；
个体记录、分组明细、原始值列表本模块根本不生成（缺政策依据即天然扣留）。
列名属于已登记 schema（与 read_metadata 同口径）可释放；模型产物名在
开关关闭前同样不可释放（由 worker 层 sanitize 把关，本模块只出结构）。
"""
from typing import Any

import pandas as pd

ANALYZE_OPERATIONS = ("schema", "key_check", "join_check", "rule_check",
                      "compare_artifacts", "run_status")

#: 期望关联基数的合法值（join_check）。
CARDINALITIES = ("1:1", "1:n", "n:1", "n:n")
#: 键空值策略（join_check）：never_match=NA 键永不匹配（默认，最保守）。
NULL_POLICIES = ("never_match", "match")

#: rule_check 首批声明式算子（§6.1）：常量比较类规则需先经需求登记，
#: 本批只收不引入个体值泄露面的结构算子；未知算子显式拒绝，绝不用 eval 兜底。
RULE_OPS = ("not_null", "unique", "equal_columns", "non_negative")

#: 请求规模护栏（**不是业务上限**）：只防单次请求携带病态数量的元素。
#: 2026-10-20 修正：原值 64 会挡住真实项目——RT01 有 66 个数据集，
#: `schema` 查全部数据集即失败。规模由项目数据决定，护栏只兜底防滥用，
#: 阈值取远高于任何真实 EDC 导出的量级。
MAX_REQUEST_ITEMS = 2000


class AnalyzeRequestError(ValueError):
    """结构化参数不满足操作合同（固定错误，不含数据值）。"""


def _require_frame(datasets: dict[str, pd.DataFrame], name: Any) -> pd.DataFrame:
    if not isinstance(name, str) or not name.strip():
        raise AnalyzeRequestError("input 必须是非空字符串（已登记数据集名）")
    frame = datasets.get(name)
    if frame is None:
        raise AnalyzeRequestError(f"输入 {name!r} 不在当前会话已登记数据集中；请以 inspect 回执的名称引用")
    return frame


def _require_columns(frame: pd.DataFrame, names: Any, field: str) -> list[str]:
    if not isinstance(names, list) or not names or len(names) > MAX_REQUEST_ITEMS:
        raise AnalyzeRequestError(f"{field} 必须是 1..{MAX_REQUEST_ITEMS} 个列名的数组")
    resolved: list[str] = []
    for name in names:
        if not isinstance(name, str):
            raise AnalyzeRequestError(f"{field} 的元素必须是字符串列名")
        if name not in frame.columns:
            raise AnalyzeRequestError(f"列 {name!r} 不在输入 schema 中")
        resolved.append(name)
    return resolved


def _key_series(frame: pd.DataFrame, keys: list[str]) -> pd.Series:
    """复合键元组序列；NA 按 never_match 语义标记为不可匹配（None）。"""
    subset = frame[keys]
    is_na = subset.isna().any(axis=1)
    tuples = [None if na else tuple(row) for na, row in zip(is_na.tolist(), subset.itertuples(index=False, name=None))]
    return pd.Series(tuples, index=frame.index)


# ---------------------------------------------------------------------------
# 操作实现：全部只返回计数
# ---------------------------------------------------------------------------

def op_schema(datasets: dict[str, pd.DataFrame], inputs: Any) -> dict[str, Any]:
    if not isinstance(inputs, list) or not inputs or len(inputs) > MAX_REQUEST_ITEMS:
        raise AnalyzeRequestError(f"inputs 必须是 1..{MAX_REQUEST_ITEMS} 个已登记数据集名的数组")
    result = []
    for name in inputs:
        frame = _require_frame(datasets, name)
        result.append({
            "name": name,
            "rowCount": int(len(frame)),
            "columnCount": int(frame.shape[1]),
            "columns": [{"name": str(column), "dtype": str(frame[column].dtype)}
                        for column in frame.columns],
        })
    return {"datasets": result}


def op_key_check(datasets: dict[str, pd.DataFrame], input_name: Any, keys: Any) -> dict[str, Any]:
    frame = _require_frame(datasets, input_name)
    key_columns = _require_columns(frame, keys, "keys")
    total = int(len(frame))
    key_series = _key_series(frame, key_columns)
    missing = int(key_series.isna().sum())
    present = key_series.dropna()
    duplicated_mask = present.duplicated(keep=False)
    duplicate_group_count = int(present[duplicated_mask].nunique())
    duplicate_row_count = int(duplicated_mask.sum())
    conclusion = "empty" if present.empty else ("unique" if duplicate_group_count == 0 else "duplicated")
    return {
        "input": input_name,
        "keys": key_columns,
        "totalRowCount": total,
        "missingKeyRowCount": missing,
        "duplicateGroupCount": duplicate_group_count,
        "duplicateRowCount": duplicate_row_count,
        "uniqueConclusion": conclusion,
    }


def op_join_check(datasets: dict[str, pd.DataFrame], left_name: Any, right_name: Any,
                  key_pairs: Any, expected_cardinality: Any, null_policy: Any) -> dict[str, Any]:
    left = _require_frame(datasets, left_name)
    right = _require_frame(datasets, right_name)
    if not isinstance(key_pairs, list) or not key_pairs or len(key_pairs) > MAX_REQUEST_ITEMS:
        raise AnalyzeRequestError(f"keyPairs 必须是 1..{MAX_REQUEST_ITEMS} 个 {{leftField,rightField}} 的数组")
    if expected_cardinality not in CARDINALITIES:
        raise AnalyzeRequestError(f"expectedCardinality 必须是 {'/'.join(CARDINALITIES)} 之一")
    if null_policy not in NULL_POLICIES:
        raise AnalyzeRequestError(f"nullPolicy 必须是 {'/'.join(NULL_POLICIES)} 之一")
    left_fields: list[str] = []
    right_fields: list[str] = []
    for pair in key_pairs:
        if not isinstance(pair, dict):
            raise AnalyzeRequestError("keyPairs 元素必须是对象")
        left_field, right_field = pair.get("leftField"), pair.get("rightField")
        if not isinstance(left_field, str) or not isinstance(right_field, str):
            raise AnalyzeRequestError("keyPairs 元素必须包含 leftField/rightField 字符串")
        if left_field not in left.columns:
            raise AnalyzeRequestError(f"列 {left_field!r} 不在左输入 schema 中")
        if right_field not in right.columns:
            raise AnalyzeRequestError(f"列 {right_field!r} 不在右输入 schema 中")
        left_fields.append(left_field)
        right_fields.append(right_field)

    left_keys = _key_series(left, left_fields)
    right_keys = _key_series(right, right_fields)
    if null_policy == "match":
        # match 语义：NA 视为可匹配哨兵值（仍不释放任何键）。
        left_keys = left_keys.fillna("<NA>")
        right_keys = right_keys.fillna("<NA>")
    left_present = left_keys.dropna()
    right_present = right_keys.dropna()
    left_matched_mask = left_present.isin(set(right_present.unique()))
    right_matched_mask = right_present.isin(set(left_present.unique()))
    left_matched_rows = int(left_matched_mask.sum())
    right_matched_rows = int(right_matched_mask.sum())

    left_counts = left_present.value_counts()
    right_counts = right_present.value_counts()
    common = left_counts.index.intersection(right_counts.index)
    joined_pair_count = int((left_counts[common] * right_counts[common]).sum())
    left_max, right_max = left_counts[common], right_counts[common]
    if expected_cardinality == "1:1":
        conflict = ((left_max > 1) | (right_max > 1))
    elif expected_cardinality == "1:n":
        conflict = (left_max > 1)
    elif expected_cardinality == "n:1":
        conflict = (right_max > 1)
    else:
        conflict = pd.Series(False, index=common)
    conflict_key_count = int(conflict.sum())
    return {
        "leftRows": int(len(left)),
        "rightRows": int(len(right)),
        "leftMatchedRowCount": left_matched_rows,
        "leftUnmatchedRowCount": int(len(left_present)) - left_matched_rows,
        "rightMatchedRowCount": right_matched_rows,
        "rightUnmatchedRowCount": int(len(right_present)) - right_matched_rows,
        "joinedPairCount": joined_pair_count,
        "cardinalityConflictKeyCount": conflict_key_count,
        "nullKeyLeftCount": int(left_keys.isna().sum()),
        "nullKeyRightCount": int(right_keys.isna().sum()),
    }


def op_rule_check(datasets: dict[str, pd.DataFrame], input_name: Any, rule: Any) -> dict[str, Any]:
    frame = _require_frame(datasets, input_name)
    if not isinstance(rule, dict):
        raise AnalyzeRequestError("rule 必须是声明式规则对象")
    op = rule.get("op")
    if op not in RULE_OPS:
        raise AnalyzeRequestError(f"不支持的规则算子 {op!r}；首批支持：{'、'.join(RULE_OPS)}")
    total = int(len(frame))
    if op == "not_null":
        (column,) = _require_columns(frame, [rule.get("column")], "rule.column")
        fail = int(frame[column].isna().sum())
    elif op == "unique":
        columns = _require_columns(frame, rule.get("columns"), "rule.columns")
        fail = int(_key_series(frame, columns).dropna().duplicated(keep=False).sum())
    elif op == "equal_columns":
        left_column, = _require_columns(frame, [rule.get("left")], "rule.left")
        right_column, = _require_columns(frame, [rule.get("right")], "rule.right")
        both = frame[[left_column, right_column]].notna().all(axis=1)
        fail = int((both & (frame[left_column] != frame[right_column])).sum())
    else:  # non_negative
        (column,) = _require_columns(frame, [rule.get("column")], "rule.column")
        numeric = pd.to_numeric(frame[column], errors="coerce")
        fail = int((numeric < 0).sum())
    return {"input": input_name, "ruleOp": op, "examinedCount": total,
            "failCount": fail, "passCount": total - fail,
            "indeterminateCount": 0}


def op_compare_artifacts(last_outputs: dict[str, pd.DataFrame],
                         left_name: Any, right_name: Any, key_columns: Any) -> dict[str, Any]:
    """比较最近一次 run_code 的两个命名产物（§6.1 compare_artifacts 首批：
    actual/expected 都引用模型产物注册名）。只返回结构/计数；键不唯一显式失败。"""
    if not isinstance(left_name, str) or left_name not in last_outputs:
        raise AnalyzeRequestError("actualRef 必须是最近一次成功 run_code 的输出名")
    if not isinstance(right_name, str) or right_name not in last_outputs:
        raise AnalyzeRequestError("expectedRef 必须是最近一次成功 run_code 的输出名")
    left, right = last_outputs[left_name], last_outputs[right_name]
    keys = _require_columns(left, key_columns, "keyColumns")
    for column in keys:
        if column not in right.columns:
            raise AnalyzeRequestError(f"列 {column!r} 不在 expectedRef schema 中")
    left_keys = _key_series(left, keys).dropna()
    right_keys = _key_series(right, keys).dropna()
    if left_keys.duplicated().any() or right_keys.duplicated().any():
        raise AnalyzeRequestError("比较键在产物中不唯一；请改用唯一键（不按位置配对）")
    left_schema = {str(column): str(left[column].dtype) for column in left.columns}
    right_schema = {str(column): str(right[column].dtype) for column in right.columns}
    only_left = sorted(set(left_schema) - set(right_schema))
    only_right = sorted(set(right_schema) - set(left_schema))
    schema_diff_count = len(only_left) + len(only_right)
    schema_diff_count += sum(1 for column in set(left_schema) & set(right_schema)
                             if left_schema[column] != right_schema[column])
    # 键值交集（不是行号交集）：两侧键已校验唯一，可安全建查找表。
    left_lookup = {key: index for index, key in left_keys.items()}
    right_lookup = {key: index for index, key in right_keys.items()}
    common_keys = set(left_lookup) & set(right_lookup)
    modified_rows = 0
    differing_cells = 0
    shared_columns = [column for column in left.columns
                      if column in right.columns and column not in keys]
    for key in common_keys:
        left_row = left.loc[left_lookup[key]]
        right_row = right.loc[right_lookup[key]]
        row_diff = 0
        for column in shared_columns:
            left_value, right_value = left_row[column], right_row[column]
            if pd.isna(left_value) and pd.isna(right_value):
                continue
            if left_value != right_value:
                row_diff += 1
        if row_diff:
            modified_rows += 1
            differing_cells += row_diff
    return {
        "leftRows": int(len(left)), "rightRows": int(len(right)),
        "schemaDiffCount": int(schema_diff_count),
        "onlyLeftColumns": only_left, "onlyRightColumns": only_right,
        "commonKeyRowCount": int(len(common_keys)),
        "addedRowCount": int(len(left_lookup) - len(common_keys)),
        "removedRowCount": int(len(right_lookup) - len(common_keys)),
        "modifiedRowCount": int(modified_rows),
        "differingCellCount": int(differing_cells),
    }
