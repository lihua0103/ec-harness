"""临床 Listing 的受限计划合同与本地验证器。

计划只描述 schema 上的关系运算，不允许脚本、路径或患者级字面量。真实记录仅由
本地执行器读取，模型只能提交此处定义的结构化 IR。
"""
from __future__ import annotations

import re
from typing import Any


PLAN_VERSION = 1
SCENARIOS = {"medical", "rbqm", "manual", "report"}
AGGREGATIONS = {"count", "count_distinct", "sum", "mean", "min", "max"}
COMPARISONS = {"eq", "ne", "gt", "gte", "lt", "lte", "is_null", "not_null"}
DERIVATIONS = {"copy", "concat", "coalesce", "date_diff_days", "add", "subtract", "multiply", "divide"}

# 计划语义的单一来源：执行器与 validator 共用，避免同一规则在两侧用字符串
# 字面量各写一遍（N-6 重复所有权）。
# spec 第 6 条要求的复核列：产物列名 → 表头标签。
REVIEW_COLUMNS: dict[str, str] = {
    "Flag": "Flag",
    "Update Details": "Update Details",
    "Review Comments": "Review Comments",
    "Initial_Date": "Initial/Date",
}
# 派生运算的入参个数约束（N-5：date_diff_days 单 ref 会在执行期 IndexError）。
DERIVATION_MIN_REFS = {"date_diff_days": 2, "add": 2, "subtract": 2, "multiply": 2, "divide": 2}
# N-1：计划资源上限，防止本地 DoS / 磁盘填满。
MAX_OUTPUTS = 64
MAX_ITEMS_PER_OUTPUT = 256


def _is_code_value_column(column: dict[str, Any]) -> bool:
    """dropCodeValue 的判据；validator 与执行器必须同口径。"""
    return "code value" in f"{column['name']} {column.get('label', '')}".casefold()


def _is_formula(text: str) -> bool:
    """N-10：Excel 公式注入面。

    openpyxl 会把 `=`/`+`/`-`/`@` 开头的字符串存为公式，使模型可控文本在交付物
    被打开时求值（引用外部工作簿、DDE）。标识符由 _IDENTIFIER 正则天然排除这些
    前缀；label 与 statusFilter 是自由文本，必须显式拒绝。
    """
    return text.lstrip().startswith(("=", "+", "-", "@"))


_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")
_QUALIFIED_IDENTIFIER = re.compile(
    r"^[A-Za-z_][A-Za-z0-9_]{0,127}(?:\.[A-Za-z_][A-Za-z0-9_]{0,127})?$"
)


class ListingPlanError(ValueError):
    """不含数据值的计划校验错误。"""

    def __init__(self, code: str, message: str, *, path: str = "plan") -> None:
        super().__init__(message)
        self.code = code
        self.path = path


def _object(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ListingPlanError("INVALID_TYPE", "计划节点必须是对象", path=path)
    return value


def _list(value: Any, path: str) -> list[Any]:
    if not isinstance(value, list):
        raise ListingPlanError("INVALID_TYPE", "计划节点必须是数组", path=path)
    return value


def _identifier(value: Any, path: str) -> str:
    text = str(value or "").strip()
    if not _IDENTIFIER.fullmatch(text):
        raise ListingPlanError("INVALID_IDENTIFIER", "数据集或字段标识无效", path=path)
    return text


def _refs(value: Any, path: str) -> list[str]:
    refs = [_identifier(item, f"{path}[{index}]") for index, item in enumerate(_list(value, path))]
    if not refs:
        raise ListingPlanError("MISSING_REFERENCE", "运算至少需要一个字段引用", path=path)
    return refs


def _column_set(columns: set[str]) -> dict[str, str]:
    return {str(column).casefold(): str(column) for column in columns}


def _resolve_ref(value: Any, available: dict[str, str], path: str) -> str:
    """解析当前输出可见的限定/非限定字段引用。"""
    reference = str(value or "").strip()
    if not _QUALIFIED_IDENTIFIER.fullmatch(reference):
        raise ListingPlanError("INVALID_IDENTIFIER", "字段引用无效", path=path)
    actual = available.get(reference.casefold())
    if actual is None:
        raise ListingPlanError("UNKNOWN_COLUMN", "计划引用了不存在的字段", path=path)
    return actual


def _literal(value: Any, path: str) -> dict[str, Any]:
    """只接受显式类型化的业务阈值，不接受隐式字符串数据。"""
    item = _object(value, path)
    if set(item) != {"type", "value"}:
        raise ListingPlanError("INVALID_LITERAL", "阈值必须包含 type 和 value", path=path)
    kind = str(item.get("type") or "")
    raw = item.get("value")
    if kind == "number" and isinstance(raw, (int, float)) and not isinstance(raw, bool):
        return {"type": kind, "value": raw}
    if kind == "boolean" and isinstance(raw, bool):
        return {"type": kind, "value": raw}
    if kind == "string" and isinstance(raw, str) and len(raw) <= 256:
        return {"type": kind, "value": raw}
    raise ListingPlanError("INVALID_LITERAL", "阈值类型或长度无效", path=path)


def _bounded_list(value: Any, path: str, limit: int = MAX_ITEMS_PER_OUTPUT) -> list[Any]:
    """N-1：带上限的数组，防止无界计划把本地执行器/磁盘打满。"""
    items = _list(value, path)
    if len(items) > limit:
        raise ListingPlanError("PLAN_TOO_LARGE", "计划节点数量超过上限", path=path)
    return items


def _bounded_int(value: Any, path: str, minimum: int, maximum: int, default: int) -> int:
    """N-2：垃圾输入必须是结构化 ListingPlanError，不能是裸 ValueError。

    裸 ValueError 会在 worker 被降级为 WORKFLOW_UNAVAILABLE，丢掉"哪个字段
    非法"的诊断，模型无法自我纠正。
    """
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ListingPlanError("INVALID_LAYOUT_REQUIREMENT", "布局数值无效", path=path)
    return max(minimum, min(int(value), maximum))


def _excel_sheet_key(name: str) -> str:
    return name.casefold()[:31]


def _validate_report_output_contract(
    outputs: list[dict[str, Any]],
    review_columns: dict[str, str],
    reserved_sheet_name: str,
) -> None:
    names: dict[str, int] = {}
    sheet_names: dict[str, int] = {}
    for index, output in enumerate(outputs):
        name_key = output["name"].casefold()
        if name_key in names:
            raise ListingPlanError(
                "DUPLICATE_OUTPUT_NAME",
                "report 输出名称必须唯一",
                path=f"plan.outputs[{index}].name",
            )
        names[name_key] = index
        sheet_key = _excel_sheet_key(output["name"])
        if sheet_key == _excel_sheet_key(reserved_sheet_name):
            raise ListingPlanError(
                "RESERVED_SHEET_NAME",
                "report 输出名称不能使用保留工作表名",
                path=f"plan.outputs[{index}].name",
            )
        if sheet_key in sheet_names:
            raise ListingPlanError(
                "DUPLICATE_SHEET_NAME",
                "report 输出名称在 Excel 工作表规则下必须唯一",
                path=f"plan.outputs[{index}].name",
            )
        sheet_names[sheet_key] = index
        column_names: dict[str, int] = {}
        for column_index, column in enumerate(output["columns"]):
            column_key = column["name"].casefold()
            if column_key in column_names:
                raise ListingPlanError(
                    "DUPLICATE_COLUMN_NAME",
                    "输出字段名称必须唯一",
                    path=f"plan.outputs[{index}].columns[{column_index}].name",
                )
            column_names[column_key] = column_index
        aliases: set[str] = set()
        for aggregation_index, aggregation in enumerate(output["aggregations"]):
            alias_key = aggregation["name"].casefold()
            if alias_key in aliases:
                raise ListingPlanError(
                    "DUPLICATE_AGGREGATION_ALIAS",
                    "聚合别名必须唯一",
                    path=f"plan.outputs[{index}].aggregations[{aggregation_index}].name",
                )
            aliases.add(alias_key)
        if output["layout"]["appendReviewColumns"]:
            for review in review_columns:
                if review.casefold() in column_names or review.casefold() in aliases:
                    raise ListingPlanError(
                        "DUPLICATE_REVIEW_COLUMN",
                        "输出字段不能覆盖复核列",
                        path=f"plan.outputs[{index}].layout.appendReviewColumns",
                    )


def _require_medical_provenance(
    outputs: list[dict[str, Any]], requirement_text: str,
) -> None:
    """F-11: medical 规则来源确认，作为计划校验规则而非生成器拦路异常。

    spec 若要求"标识 New/Modified"或"只呈现 Status 为已编码的信息"，产物就必须
    真的带上对应机制：变更标识依赖复核列（appendReviewColumns），编码状态依赖
    statusFilter。旧路径的做法是在生成器里抛 ListingNeedsInput 把整轮打回
    needs_input，模型看不到"缺什么"；这里改为结构化拒绝并指明缺失的计划字段，
    模型可以直接补齐后重提。
    """
    text = requirement_text.casefold()
    needs_change_baseline = "new" in text and "modified" in text
    needs_coding_status = "已编码" in text and "status" in text
    if needs_change_baseline and not any(
        output["layout"]["appendReviewColumns"] for output in outputs
    ):
        raise ListingPlanError(
            "MEDICAL_PROVENANCE_REQUIRED",
            "spec 要求标识 New/Modified，计划必须启用 appendReviewColumns 复核列",
            path="plan.outputs[0].layout.appendReviewColumns",
        )
    if needs_coding_status and not any(
        output["layout"]["statusFilter"] for output in outputs
    ):
        raise ListingPlanError(
            "MEDICAL_PROVENANCE_REQUIRED",
            "spec 要求只呈现已编码信息，计划必须声明 statusFilter",
            path="plan.outputs[0].layout.statusFilter",
        )


def validate_listing_plan(
    plan: Any, schema: dict[str, set[str]], scenario: str,
    requirement_text: str = "",
    review_columns: dict[str, str] | None = None,
    reserved_sheet_name: str = "contents",
) -> dict[str, Any]:
    """验证并规范化模型提交的 IR；schema 只包含本地读取的字段名。"""
    review_columns = review_columns or REVIEW_COLUMNS
    source = _object(plan, "plan")
    allowed_root = {"version", "scenario", "outputs", "assumptions", "toc"}
    unknown = set(source) - allowed_root
    if unknown:
        raise ListingPlanError("UNKNOWN_PROPERTY", "计划包含未授权属性", path=f"plan.{sorted(unknown)[0]}")
    if source.get("version") != PLAN_VERSION:
        raise ListingPlanError("UNSUPPORTED_VERSION", "计划版本不受支持", path="plan.version")
    if source.get("scenario") != scenario or scenario not in SCENARIOS:
        raise ListingPlanError("SCENARIO_MISMATCH", "计划场景与请求不一致", path="plan.scenario")

    normalized_outputs = []
    for output_index, raw_output in enumerate(_bounded_list(source.get("outputs"), "plan.outputs", MAX_OUTPUTS)):
        path = f"plan.outputs[{output_index}]"
        output = _object(raw_output, path)
        allowed = {"name", "source", "joins", "columns", "filters", "derivations", "groupBy", "aggregations", "sort", "layout"}
        if set(output) - allowed:
            raise ListingPlanError("UNKNOWN_PROPERTY", "输出包含未授权属性", path=path)
        name = _identifier(output.get("name"), f"{path}.name")
        source_name = _identifier(output.get("source"), f"{path}.source")
        if source_name.casefold() not in schema:
            raise ListingPlanError("UNKNOWN_DATASET", "计划引用了未知数据集", path=f"{path}.source")
        available = _column_set(schema[source_name.casefold()])
        for column in schema[source_name.casefold()]:
            available[f"{source_name}.{column}".casefold()] = f"{source_name}.{column}"

        joins = []
        for index, raw_join in enumerate(_bounded_list(output.get("joins", []), f"{path}.joins")):
            join_path = f"{path}.joins[{index}]"
            join = _object(raw_join, join_path)
            if set(join) - {"dataset", "type", "leftKeys", "rightKeys"}:
                raise ListingPlanError("UNKNOWN_PROPERTY", "连接包含未授权属性", path=join_path)
            dataset = _identifier(join.get("dataset"), f"{join_path}.dataset")
            dataset_columns = schema.get(dataset.casefold())
            if dataset_columns is None:
                raise ListingPlanError("UNKNOWN_DATASET", "连接引用了未知数据集", path=f"{join_path}.dataset")
            join_type = str(join.get("type") or "left")
            if join_type not in {"left", "inner"}:
                raise ListingPlanError("INVALID_JOIN", "只允许 left 或 inner 连接", path=f"{join_path}.type")
            left_keys = _refs(join.get("leftKeys"), f"{join_path}.leftKeys")
            right_keys = _refs(join.get("rightKeys"), f"{join_path}.rightKeys")
            if len(left_keys) != len(right_keys):
                raise ListingPlanError("INVALID_JOIN", "连接键数量不一致", path=join_path)
            if any(key.casefold() not in available for key in left_keys):
                raise ListingPlanError("UNKNOWN_COLUMN", "连接左键不存在", path=f"{join_path}.leftKeys")
            if any(key.casefold() not in _column_set(dataset_columns) for key in right_keys):
                raise ListingPlanError("UNKNOWN_COLUMN", "连接右键不存在", path=f"{join_path}.rightKeys")
            for column in dataset_columns:
                available[f"{dataset}.{column}".casefold()] = f"{dataset}.{column}"
            joins.append({"dataset": dataset, "type": join_type, "leftKeys": left_keys, "rightKeys": right_keys})

        derivations = []
        for index, raw_derivation in enumerate(_bounded_list(output.get("derivations", []), f"{path}.derivations")):
            item_path = f"{path}.derivations[{index}]"
            item = _object(raw_derivation, item_path)
            if set(item) - {"name", "operation", "refs", "separator"}:
                raise ListingPlanError("UNKNOWN_PROPERTY", "派生包含未授权属性", path=item_path)
            derived_name = _identifier(item.get("name"), f"{item_path}.name")
            operation = str(item.get("operation") or "")
            if operation not in DERIVATIONS:
                raise ListingPlanError("INVALID_DERIVATION", "派生运算不受支持", path=f"{item_path}.operation")
            refs = [_resolve_ref(ref, available, f"{item_path}.refs[{ref_index}]") for ref_index, ref in enumerate(_bounded_list(item.get("refs"), f"{item_path}.refs"))]
            if not refs:
                raise ListingPlanError("MISSING_REFERENCE", "派生运算至少需要一个字段引用", path=f"{item_path}.refs")
            # N-5: arity 必须在校验期拒绝。date_diff_days 只给一个 ref 会在执行期
            # IndexError，被降级成不可诊断的 WORKFLOW_UNAVAILABLE。
            if len(refs) < DERIVATION_MIN_REFS.get(operation, 1):
                raise ListingPlanError("INVALID_DERIVATION", "派生运算的字段引用数量不足", path=f"{item_path}.refs")
            separator = str(item.get("separator") or "")
            if len(separator) > 16:
                raise ListingPlanError("INVALID_LITERAL", "连接分隔符过长", path=f"{item_path}.separator")
            derivations.append({"name": derived_name, "operation": operation, "refs": refs, "separator": separator})
            available[derived_name.casefold()] = derived_name

        filters = []
        for index, raw_filter in enumerate(_bounded_list(output.get("filters", []), f"{path}.filters")):
            item_path = f"{path}.filters[{index}]"
            item = _object(raw_filter, item_path)
            if set(item) - {"column", "operator", "valueRef", "literal"}:
                raise ListingPlanError("UNKNOWN_PROPERTY", "过滤条件包含未授权属性", path=item_path)
            if "valueRef" in item and "literal" in item:
                raise ListingPlanError("INVALID_FILTER", "过滤条件不能同时引用字段和阈值", path=item_path)
            column = _resolve_ref(item.get("column"), available, f"{item_path}.column")
            operator = str(item.get("operator") or "")
            if operator not in COMPARISONS:
                raise ListingPlanError("INVALID_FILTER", "过滤运算不受支持", path=f"{item_path}.operator")
            value_ref = item.get("valueRef")
            literal = None
            if operator not in {"is_null", "not_null"}:
                if value_ref is not None:
                    value_ref = _resolve_ref(value_ref, available, f"{item_path}.valueRef")
                elif "literal" in item:
                    literal = _literal(item.get("literal"), f"{item_path}.literal")
                else:
                    raise ListingPlanError("MISSING_REFERENCE", "过滤条件缺少字段或类型化阈值", path=item_path)
            elif value_ref not in (None, ""):
                raise ListingPlanError("INVALID_FILTER", "空值判断不能携带比较值", path=f"{item_path}.valueRef")
            elif "literal" in item:
                # N-4: 此前 is_null/not_null 携带的 literal 被静默丢弃。静默忽略
                # 模型的显式意图会让"计划写错了"表现为"结果不对"，必须显式拒绝。
                raise ListingPlanError("INVALID_FILTER", "空值判断不能携带阈值", path=f"{item_path}.literal")
            filters.append({"column": column, "operator": operator, "valueRef": value_ref or "", "literal": literal})

        group_by = [_resolve_ref(item, available, f"{path}.groupBy[{index}]") for index, item in enumerate(_bounded_list(output.get("groupBy", []), f"{path}.groupBy"))]
        aggregations = []
        for index, raw_aggregate in enumerate(_bounded_list(output.get("aggregations", []), f"{path}.aggregations")):
            item_path = f"{path}.aggregations[{index}]"
            item = _object(raw_aggregate, item_path)
            if set(item) - {"name", "operation", "column"}:
                raise ListingPlanError("UNKNOWN_PROPERTY", "聚合包含未授权属性", path=item_path)
            operation = str(item.get("operation") or "")
            if operation not in AGGREGATIONS:
                raise ListingPlanError("INVALID_AGGREGATION", "聚合运算不受支持", path=f"{item_path}.operation")
            aggregations.append({"name": _identifier(item.get("name"), f"{item_path}.name"), "operation": operation, "column": _resolve_ref(item.get("column"), available, f"{item_path}.column")})
            # F-6（反向不一致）：聚合别名此前未注册进 available，使"输出聚合结果"
            # 的计划被 validator 以 UNKNOWN_COLUMN 拒绝——聚合能力实际不可用。
            available[aggregations[-1]["name"].casefold()] = aggregations[-1]["name"]

        columns = []
        for index, raw_column in enumerate(_bounded_list(output.get("columns"), f"{path}.columns")):
            item_path = f"{path}.columns[{index}]"
            item = _object(raw_column, item_path)
            if set(item) - {"source", "name", "label"}:
                raise ListingPlanError("UNKNOWN_PROPERTY", "输出字段包含未授权属性", path=item_path)
            label = str(item.get("label") or "").strip()
            if len(label) > 256:
                raise ListingPlanError("INVALID_LABEL", "字段标签过长", path=f"{item_path}.label")
            if _is_formula(label):
                raise ListingPlanError("INVALID_LABEL", "字段标签不能以公式前缀开头", path=f"{item_path}.label")
            columns.append({"source": _resolve_ref(item.get("source"), available, f"{item_path}.source"), "name": _identifier(item.get("name"), f"{item_path}.name"), "label": label})
        if not columns and not aggregations:
            raise ListingPlanError("EMPTY_OUTPUT", "输出必须包含字段或聚合", path=path)

        layout = _object(output.get("layout", {}), f"{path}.layout")
        if set(layout) - {"freezeColumns", "freezeRows", "includeContents", "toc", "dropCodeValue", "titleLanguage", "appendReviewColumns", "statusFilter", "unsupportedRequirements"}:
            raise ListingPlanError("UNKNOWN_PROPERTY", "布局包含未授权属性", path=f"{path}.layout")
        title_language = str(layout.get("titleLanguage", "") or "")
        if title_language not in {"", "zh", "中文"}:
            raise ListingPlanError("UNSUPPORTED_LAYOUT_REQUIREMENT", "当前执行器只支持中文标题", path=f"{path}.layout.titleLanguage")
        unsupported = _bounded_list(layout.get("unsupportedRequirements", []), f"{path}.layout.unsupportedRequirements")
        if any(not isinstance(item, str) or len(item) > 256 for item in unsupported):
            raise ListingPlanError("INVALID_LAYOUT_REQUIREMENT", "未支持需求说明无效", path=f"{path}.layout.unsupportedRequirements")
        drop_code_value = bool(layout.get("dropCodeValue", False))
        append_review = bool(layout.get("appendReviewColumns", False))
        # N-3: statusFilter 是自由文本比较值，此前无长度上限也不拒绝公式前缀。
        # 它按列名匹配任意 "status" 列，不经 schema 校验，因此至少要与 literal
        # 同口径受限（长度 + 公式前缀）。
        status_filter = str(layout.get("statusFilter", "") or "")
        if len(status_filter) > 256 or _is_formula(status_filter):
            raise ListingPlanError("INVALID_LAYOUT_REQUIREMENT", "状态过滤值无效", path=f"{path}.layout.statusFilter")

        sort = []
        # F-6: 排序列域必须与执行器一致。执行器在投影出输出列之后排序，因此
        # 可排序的只有真实存在于产物里的列：未被 dropCodeValue 移除的输出列名
        # +（启用时）追加的复核列。此前 validator 按 available（全部源字段）校验，
        # 导致"validator 放行、executor 抛 sort field must be present in
        # output columns"；反向地聚合别名进不了 available 又让合法计划被拒。
        sortable = {
            item["name"].casefold(): item["name"]
            for item in columns
            if not (drop_code_value and _is_code_value_column(item))
        }
        if append_review:
            for review in review_columns:
                sortable[review.casefold()] = review
        for index, raw_sort in enumerate(_bounded_list(output.get("sort", []), f"{path}.sort")):
            item = _object(raw_sort, f"{path}.sort[{index}]")
            direction = str(item.get("direction") or "asc")
            if set(item) - {"column", "direction"} or direction not in {"asc", "desc"}:
                raise ListingPlanError("INVALID_SORT", "排序定义无效", path=f"{path}.sort[{index}]")
            sort.append({"column": _resolve_ref(item.get("column"), sortable, f"{path}.sort[{index}].column"), "direction": direction})

        normalized_outputs.append({"name": name, "source": source_name, "joins": joins, "columns": columns, "filters": filters, "derivations": derivations, "groupBy": group_by, "aggregations": aggregations, "sort": sort, "layout": {"freezeColumns": _bounded_int(layout.get("freezeColumns"), f"{path}.layout.freezeColumns", 0, 100, 0), "freezeRows": _bounded_int(layout.get("freezeRows"), f"{path}.layout.freezeRows", 0, 10, 1), "includeContents": bool(layout.get("includeContents", scenario in {"medical", "report"})), "toc": bool(layout.get("toc", False)), "dropCodeValue": drop_code_value, "titleLanguage": "zh" if title_language else "", "appendReviewColumns": append_review, "statusFilter": status_filter, "unsupportedRequirements": [str(item)[:256] for item in unsupported]}})

    if not normalized_outputs:
        raise ListingPlanError("EMPTY_PLAN", "计划至少需要一个输出", path="plan.outputs")

    if scenario == "report":
        _validate_report_output_contract(normalized_outputs, review_columns, reserved_sheet_name)

    if scenario == "medical" and requirement_text:
        _require_medical_provenance(normalized_outputs, requirement_text)

    return {"version": PLAN_VERSION, "scenario": scenario, "outputs": normalized_outputs, "toc": bool(source.get("toc", False)), "assumptions": [str(item)[:256] for item in _bounded_list(source.get("assumptions", []), "plan.assumptions")[:64]]}
