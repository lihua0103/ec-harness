"""归一化格式族匹配（2026-08-30 系统级重构 B 支柱）靶场。

真实 AI 实测的三类逃逸（repr 包裹 / 时间戳毫秒-微秒位差 / pandas 渲染
浮点尾零）由**格式族规则**统一覆盖——规则作用于"格式族"而非逐场景：
同一单元格值以 str / repr / pandas 表格渲染 / datetime 截断 / 前后缀
嵌入五种形态出现，全部遮蔽。全部合成数据。
"""
import pandas as pd

from source_registry import DataStr
from value_mask import (
    _canon,
    build_value_set,
    compile_matcher,
    mask_receipt_strings,
    mask_text,
)


def _frame(values):
    return pd.DataFrame({"A": values})


# ---------------------------------------------------------------------------
# _canon：归一化函数单元口径（值集与文本匹配共用同一函数）
# ---------------------------------------------------------------------------

def test_canon_timestamp_family_collapses_fractional_seconds():
    """时间戳族归一：任意小数秒位与 T/空格分隔 → 秒级空格规范形。"""
    assert _canon("2026-07-29 04:04:57.303456") == "2026-07-29 04:04:57"
    assert _canon("2026-07-29 04:04:57.303") == "2026-07-29 04:04:57"
    assert _canon("2026-07-29 04:04:57.3") == "2026-07-29 04:04:57"
    assert _canon("2026-07-29 04:04:57") == "2026-07-29 04:04:57"
    assert _canon("2026-07-29T04:04:57.303456") == "2026-07-29 04:04:57"
    assert _canon("2026-07-29T04:04:57") == "2026-07-29 04:04:57"


def test_canon_float_family_strips_trailing_zeros():
    """浮点族归一：剥尾零与孤立尾点——pandas/CSV 渲染与 repr 的尾零差、
    int/float 等价（12345 ↔ 12345.0）同时成立。"""
    assert _canon("31.0") == "31"
    assert _canon("31.000") == "31"
    assert _canon("40.10") == "40.1"
    assert _canon("0.500") == "0.5"
    assert _canon("12345.0") == "12345"
    assert _canon("12345") == "12345"                      # int 形态：自身即规范形


def test_canon_leaves_plain_strings_alone():
    """普通字符串零处理（误伤面为零的前提）。"""
    for text in ("SUBJ-777", "Headache", "np.float64", "SITE 001", "2024", "1e-05"):
        assert _canon(text) == text


def test_canon_negative_float():
    assert _canon("-12.50") == "-12.5"
    assert _canon("-12.0") == "-12"


# ---------------------------------------------------------------------------
# 格式族靶：同一值五种形态，全部遮蔽（规则族，不是逐场景堵）
# ---------------------------------------------------------------------------

def test_same_timestamp_value_masked_in_all_render_forms():
    """【真实逃逸复现】时间戳 2026-07-29 04:04:57.303（毫秒打印形态）——
    值集以 str(Timestamp) 微秒 6 位入集，文本侧五种形态全遮。"""
    ts = pd.Timestamp("2026-07-29 04:04:57.303456")
    values, _stats = build_value_set({"DS": pd.DataFrame({"AETSTDTC": [ts]})})
    forms = [
        "2026-07-29 04:04:57.303456",   # str(Timestamp) 微秒 6 位
        "2026-07-29 04:04:57.303",      # pandas 表格毫秒 3 位（实测逃逸形态）
        "2026-07-29 04:04:57.30",       # 任意 2 位
        "2026-07-29 04:04:57",          # 秒级
        "2026-07-29T04:04:57.303456",   # isoformat T 分隔
    ]
    for form in forms:
        assert mask_text(form, values) == "[DATA]", form
    # 前后缀嵌入（f-string/ID= 形态）同样整段遮蔽
    assert mask_text("time=2026-07-29 04:04:57.303;end", values) == "time=[DATA];end"
    # 相异日期/时刻（任何片段都不是值集成员）不误遮
    assert mask_text("2027-01-01 04:04:58.303", values) == "2027-01-01 04:04:58.303"


def test_same_float_value_masked_in_all_render_forms():
    """【真实逃逸复现】np.float64(31.0) repr 打印——值 31.0 的浮点族形态
    （repr 包裹 / 尾零变体 / int 等价）全遮。"""
    values, _stats = build_value_set({"DS": _frame([31.0, 1234.5])})
    assert mask_text("np.float64(31.0)", values) == "np.float64([DATA])"   # repr 包裹（实测逃逸形态）
    assert mask_text("31.0", values) == "[DATA]"                            # str 形态
    assert mask_text("31.000", values) == "[DATA]"                         # 尾零渲染变体
    assert mask_text("x=31.0;y", values) == "x=[DATA];y"                   # 前后缀嵌入
    assert mask_text("np.float64(1234.5)", values) == "np.float64([DATA])"
    assert mask_text("1234.50", values) == "[DATA]"                        # 尾零形态（canon 同族）
    # 相异浮点不误遮
    assert mask_text("31.5", values) == "31.5"


def test_int_float_equivalence_masked():
    """int/float 等价形（任务书口径 31.0↔31 的长值档）：数值单元格 12345.0
    入集，文本 12345 / 12345.0 / 00012345.0? —— 等价形态遮蔽。"""
    values, _stats = build_value_set({"DS": _frame([12345.0])})
    assert mask_text("count is 12345", values) == "count is [DATA]"
    assert mask_text("count is 12345.0", values) == "count is [DATA]"
    assert mask_text("np.float64(12345.0)", values) == "np.float64([DATA])"
    assert mask_text("12346", values) == "12346"           # 相邻整数不误遮


def test_site_code_spacing_and_padding_forms():
    """【实测逃逸 SITE 001 形态】多词值 + 首尾空白折叠：对齐填充/边白
    形态由变体族与含空白滑窗覆盖。"""
    values, _stats = build_value_set({"DS": _frame(["SITE 001", "SITE 002"])})
    assert mask_text("SITE 001", values) == "[DATA]"
    assert mask_text("loc SITE 001 end", values) == "loc [DATA] end"
    assert mask_text("xxSITE 001xx", values) == "xx[DATA]xx"
    assert mask_text("SITE 003", values) == "SITE 003"     # 相异值不误遮


def test_receipt_stdout_head_print_all_value_families_masked():
    """端到端：AI 真实 head() 打印墙（混合列类型）——datetime 毫秒位、
    float repr、float 渲染、标识符全部遮蔽，列名/索引零误伤。"""
    frame = pd.DataFrame({
        "USUBJID": ["AB1234-0011", "AB1234-0022"],
        "AESTDTC": pd.to_datetime(
            ["2026-07-29 04:04:57.303456", "2026-07-30 10:00:00"], format="mixed"),
        "DOSE": [31.0, 40.5],
    })
    values, _stats = build_value_set({"DS": frame})
    stdout = str(frame.head(2))                            # 真实表格打印形态
    masked = mask_receipt_strings({"stdout": DataStr(stdout)}, values)
    for leaked in ("AB1234-0011", "2026-07-29", "04:04:57", "31.0", "40.5"):
        assert leaked not in masked["stdout"], leaked      # 行值任意渲染形态零出域
    assert "USUBJID" in masked["stdout"]                   # 列名零误伤
    assert "AESTDTC" in masked["stdout"]


def test_mixed_project_columns_format_family_is_generic():
    """规则族通用性：换一组完全不同的列（任意项目任意列）同规则生效——
    不存在按列名/来源的场景特例。"""
    frame = pd.DataFrame({
        "CENTER": ["C-0491-1029", "C-0491-1030"],
        "LBDT": pd.to_datetime(["2025-12-01 08:30:15.999888", "2025-12-02 09:00:00"],
                               format="mixed"),
        "VAL": [0.0750, 0.1250],
    })
    values, _stats = build_value_set({"DS": frame})
    assert mask_text("site C-0491-1029 ok", values) == "site [DATA] ok"
    assert mask_text("2025-12-01 08:30:15.999", values) == "[DATA]"   # 毫秒截断
    assert mask_text("0.0750", values) == "[DATA]"                    # 尾零渲染
    assert mask_text("0.075", values) == "[DATA]"                     # 剥零等价
    assert mask_text("C-0491-9999", values) == "C-0491-9999"          # 相异值零误伤


def test_canon_forms_stats_exposed():
    """canonForms 纯计数：数字引导成员产生规范形集，普通字符串成员零产生。"""
    mixed = compile_matcher(frozenset({"31.0", "2026-07-29 04:04:57.303", "SUBJ-777"}))
    assert mixed.stats["canonForms"] == 2                   # 浮点 1 + 时间戳 1
    plain = compile_matcher(frozenset({"SUBJ-777", "Headache"}))
    assert plain.stats["canonForms"] == 0
