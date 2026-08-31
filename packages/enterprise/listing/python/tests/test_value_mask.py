"""FR-8 值遮蔽（2026-08-30 系统级重构）：构造期标注 + 归一化格式族匹配。

绝对 0 泄露口径保持：回执出域前命中数据集单元格值（含格式族归一化
等价形态）的内容替换 ``[DATA]``；开关 dataInterception=false 时遮蔽同步
关闭。

新架构断言口径（旧 PROTOCOL_KEYS/SOFT_KEYS/软硬双通道断言已按重构后
语义改写并逐处注明）：

- **构造期标注**：DataStr 叶子/键 → 遮蔽；plain str → 永不遮蔽（协议
  词/白名单元数据/doc 内容）；doc 子树豁免由默认规则自动成立。
- **归一化格式族**：同一值以 str/repr/pandas/datetime 任意小数秒位/
  浮点尾零等形态出现均遮蔽（见 test_format_family.py）。
- **统一滑窗**：len>=4 全值（含短多词/单 token 内嵌）由 4 字符前缀桶
  全文滑窗覆盖；双侧包裹标点整 token 扩张、单侧残形标点保留。

BUG-R1（2026-08-30）：上限默认 1,000,000（DSH_VALUE_SET_MAX 可覆盖）；
降级截取（频次降序, 长度降序, 首现顺序）——高频短值必入集。
"""
import json
import time

import pandas as pd

import pytest

from source_registry import DataStr
from value_mask import (
    MAX_VALUE_SET,
    MIN_VALUE_LEN,
    VALUE_SET_MAX_ENV,
    build_value_set,
    compile_matcher,
    mask_receipt_strings,
    mask_text,
)


def _frame(values):
    return pd.DataFrame({"A": values})


# ---------------------------------------------------------------------------
# build_value_set：入集口径 / 去重 / 上限降级（语义与旧架构一致）
# ---------------------------------------------------------------------------

def test_build_value_set_keeps_len4_and_drops_short_and_null():
    frame = pd.DataFrame({"A": ["SUBJ-777", "Headache", "abc", "x"],
                          "B": ["Myocardial Infarction", 12345, None, float("nan")]})
    values, stats = build_value_set({"AE": frame})
    assert values == frozenset({"SUBJ-777", "Headache", "Myocardial Infarction", "12345"})
    assert stats == {"total": 4, "selected": 4, "degraded": False, "dropped": 0}


def test_build_value_set_dedupes_across_datasets():
    values, stats = build_value_set({
        "AE": _frame(["SUBJ-777", "SUBJ-777"]),
        "DM": _frame(["SUBJ-777", "Nausea"]),
    })
    assert values == frozenset({"SUBJ-777", "Nausea"})
    assert stats["total"] == 2


def test_build_value_set_empty_datasets_identity():
    values, stats = build_value_set({})
    assert values == frozenset()
    assert stats == {"total": 0, "selected": 0, "degraded": False, "dropped": 0}


def test_min_value_len_is_policy_constant():
    """【策略常量】len<4 短值豁免：单字符/年份级噪声的误伤下限
    （2026-08-29 终裁口径保留，集中声明不再散落）。"""
    assert MIN_VALUE_LEN == 4


def test_build_value_set_dtype_fast_path_matches_object_path():
    """dtype 快路径（数值列 notna→astype(str)→Counter）与 object 逐格
    语义一致：astype(str) 逐元素等价 str(cell)——int64 列给 "12345"、
    float64 列给 "31.5"（列内类型一致，无 int/float 强转歧义）。"""
    numeric = pd.DataFrame({"V": [12345, 67890], "W": [31.5, 40.25]})
    as_object = pd.DataFrame({"V": ["12345", "67890"], "W": ["31.5", "40.25"]})
    fast_values, fast_stats = build_value_set({"DS": numeric})
    slow_values, slow_stats = build_value_set({"DS": as_object})
    assert fast_values == slow_values == frozenset({"12345", "67890", "31.5", "40.25"})
    assert fast_stats == slow_stats == {"total": 4, "selected": 4,
                                        "degraded": False, "dropped": 0}


def test_build_value_set_default_cap_is_one_million(monkeypatch):
    """BUG-R1：默认上限 1,000,000——真实项目 distinct 5 万+不再常态降级；
    不真造百万值，用小 env 值模拟覆盖语义。"""
    assert MAX_VALUE_SET == 1_000_000
    assert VALUE_SET_MAX_ENV == "DSH_VALUE_SET_MAX"
    rows = [f"S-{i:05d}" for i in range(100)]            # 100 distinct，远低于默认
    values, stats = build_value_set({"DS": _frame(rows)})
    assert stats["degraded"] is False and stats["dropped"] == 0
    monkeypatch.setenv(VALUE_SET_MAX_ENV, "1000000")     # 显式 1M 同样不降级
    again, stats2 = build_value_set({"DS": _frame(rows)})
    assert stats2["degraded"] is False and again == values


def test_build_value_set_cap_env_override_each_call(monkeypatch):
    """DSH_VALUE_SET_MAX 覆盖上限；build_value_set 每次调用时读 env，
    setenv/delenv 立即生效；非法值回落默认（不把值集清零）。"""
    rows = [f"S-{i:04d}" for i in range(10)]             # 10 distinct，各 1 次
    frame = _frame(rows)
    monkeypatch.setenv(VALUE_SET_MAX_ENV, "6")
    values, stats = build_value_set({"DS": frame})
    assert stats == {"total": 10, "selected": 6, "degraded": True, "dropped": 4}
    again, stats2 = build_value_set({"DS": frame})       # env 在每次调用时读取
    assert again == values and stats2 == stats
    monkeypatch.setenv(VALUE_SET_MAX_ENV, "not-a-number")
    values3, stats3 = build_value_set({"DS": frame})
    assert stats3 == {"total": 10, "selected": 10, "degraded": False, "dropped": 0}
    monkeypatch.delenv(VALUE_SET_MAX_ENV)
    values4, stats4 = build_value_set({"DS": frame})
    assert stats4["degraded"] is False and values4 == frozenset(rows)


def test_build_value_set_cap_deterministic_truncation(monkeypatch):
    """超上限按（频次降序, 长度降序, 首现顺序）确定性截取（同频场景：
    长度降序优先，同频同长按首现顺序）。dtype 快路径的 Counter 同样保持
    首现插入序，截取序与旧逐格实现一致。"""
    cap = 50
    monkeypatch.setenv(VALUE_SET_MAX_ENV, str(cap))
    rows = [f"SUBJ-{i:06d}" for i in range(cap)]         # 全部 11 字符、同频 1
    rows += ["LONG-PADDING-VALUE-KEEP", "short"]         # 更长者与最短者（同频 1）
    frame = _frame(rows)
    values, stats = build_value_set({"DS": frame})
    assert stats["total"] == cap + 2
    assert stats["selected"] == cap and stats["dropped"] == 2
    assert stats["degraded"] is True
    assert "LONG-PADDING-VALUE-KEEP" in values           # 同频下长度降序优先保留
    assert "short" not in values                         # 同频下最短者被截掉
    assert "SUBJ-000000" in values and "SUBJ-000049" not in values  # 同频同长按首现顺序
    again, stats2 = build_value_set({"DS": frame})
    assert again == values and stats2 == stats           # 确定性：两次一致


def test_build_value_set_degradation_keeps_high_frequency_short_values(monkeypatch):
    """BUG-R1 复现：大量低频长值 + 少数高频短值超上限时，高频短值必须
    入集——旧排序只按长度降序，高频短值被低频长值挤出遮蔽集，导致
    run_code stdout 中真实行值原文出域。"""
    rows = ["HEAD"] * 500                                # 高频短值：泄露主体
    rows += [f"RARE-LONG-PADDING-{i:06d}" for i in range(600)]   # 低频长值
    frame = _frame(rows)
    monkeypatch.setenv(VALUE_SET_MAX_ENV, "100")
    values, stats = build_value_set({"DS": frame})
    assert stats["total"] == 601, stats
    assert stats["selected"] == 100 and stats["degraded"] is True and stats["dropped"] == 501
    assert "HEAD" in values                              # 高频短值必入集
    assert len([v for v in values if v.startswith("RARE")]) == 99   # 低频长值按序补位
    assert mask_text("hit HEAD here", values) == "hit [DATA] here"  # 端到端：出域前被遮蔽


def test_build_value_set_frequency_beats_length(monkeypatch):
    """频次降序优先于长度降序：高频短值压过低频长值入选。"""
    monkeypatch.setenv(VALUE_SET_MAX_ENV, "2")
    frame = _frame(["DIZZ"] * 10 + ["A-VERY-LONG-RARE-VALUE", "ANOTHER-RARE"])
    values, stats = build_value_set({"DS": frame})
    assert stats["total"] == 3
    assert stats["selected"] == 2 and stats["degraded"] is True and stats["dropped"] == 1
    assert "DIZZ" in values                              # 频次 11 > 1，短值必留
    assert "A-VERY-LONG-RARE-VALUE" in values            # 剩余按长度降序补位
    assert "ANOTHER-RARE" not in values


def test_build_value_set_whitespace_fold_variant():
    """变体族——首尾空白折叠：带边白单元格值的 stripped 形态入集（表格
    对齐填充/str 带边白形态命中），stats 按原始值口径不重复计数。"""
    frame = _frame(["  SITE-001  ", "SITE-002"])
    values, stats = build_value_set({"DS": frame})
    assert "  SITE-001  " in values                      # 规范形
    assert "SITE-001" in values                          # 折叠变体
    assert "SITE-002" in values
    assert stats == {"total": 2, "selected": 2, "degraded": False, "dropped": 0}


# ---------------------------------------------------------------------------
# mask_text：统一滑窗语义（重构后不再有软/硬双通道——旧 hard 通道的
# "len<8 嵌入不遮"断言已按新语义改写并注明）
# ---------------------------------------------------------------------------

VALUES = frozenset({"SUBJ-777", "Headache", "Myocardial Infarction", "abc123"})


def test_mask_text_whole_token_hit():
    assert mask_text("SUBJ-777 出现 Headache", VALUES) == "[DATA] 出现 [DATA]"


def test_mask_text_strips_wrapping_punctuation():
    """双侧包裹标点（repr 形态 '(Headache);' / '"SUBJ-777",'）整 token 替换。"""
    assert mask_text('(Headache); "SUBJ-777",', VALUES) == "[DATA] [DATA]"


def test_mask_text_no_hit_unchanged_zero_false_positive():
    text = "Head aches for SUBJ77 subjects; int64 object float64\n2024-01-01 正常文本"
    assert mask_text(text, VALUES) == text


def test_mask_text_short_value_embedding_masked():
    """【旧 hard 通道断言改写】统一滑窗后 len 4-7 值的嵌入形态（旧软通道
    C2/C3 场景）同样遮蔽——旧断言 "x=abc123;" 不遮属已删除的双通道口径。"""
    assert mask_text("abc123", VALUES) == "[DATA]"
    assert mask_text("x=abc123;", VALUES) == "x=[DATA];"


def test_mask_text_embedded_long_value_fallback():
    assert mask_text("ID=SUBJ-777;", VALUES) == "ID=[DATA];"
    assert mask_text("a,Headache]b", VALUES) == "a,[DATA]]b"   # 单侧残形标点：仅替换命中子串


def test_mask_text_repr_wrapped_keeps_one_sided_punct():
    """单侧包裹标点保留（旧实现基线缺陷修复）：尾 ';'、字典 repr 的 '{'
    不被吞——只替换命中子串，值本身零泄露。"""
    assert mask_text("err on 12.5;", frozenset({"12.5"})) == "err on [DATA];"
    assert mask_text("np.float64(12.5)", frozenset({"12.5"})) == "np.float64([DATA])"


def test_mask_text_multiword_long_value_embedded():
    assert mask_text("dx=Myocardial Infarction;grade=3", VALUES) == "dx=[DATA];grade=3"
    assert mask_text("Myocardial Infarction", VALUES) == "[DATA]"


def test_mask_text_short_multiword_embedded():
    """短多词值（len 4-7 含空白，旧 C2 场景）：统一滑窗整段命中——
    窗口含空白原样参与。"""
    values = frozenset({"MILD 1"})
    assert mask_text("grade MILD 1;", values) == "grade [DATA];"
    assert mask_text("   AETOXGR\n0  MILD 1\n", values) == "   AETOXGR\n0  [DATA]\n"


def test_mask_text_preserves_whitespace_and_newlines():
    assert mask_text("a  SUBJ-777\n\nb\tHeadache", VALUES) == "a  [DATA]\n\nb\t[DATA]"


def test_mask_text_empty_inputs_identity():
    assert mask_text("", VALUES) == ""
    assert mask_text("SUBJ-777", frozenset()) == "SUBJ-777"


# ---------------------------------------------------------------------------
# mask_receipt_strings：DataStr 通道 + plain 直通（构造期标注架构）
# ---------------------------------------------------------------------------

def test_mask_receipt_strings_masks_datastr_leaves_only():
    """【旧"全部字符串叶子遮蔽"断言改写】重构后只有 DataStr 叶子遮蔽——
    回执构造点（worker/discovery）对数据派生与回显文本包 DataStr，
    plain str（协议值/白名单元数据）永不遮蔽。"""
    receipt = {
        "ok": False, "code": "CODE_EXECUTION_ERROR",
        "reason": DataStr("failed on SUBJ-777"),
        "stdout": DataStr("Headache\n"),
        "stderr": DataStr("ID=SUBJ-777;"),
        "environmentHint": DataStr("see SUBJ-777 docs"),
        "outputs": {"LISTING": {"columns": [{"name": DataStr("Headache")}]}},
        "nested": [{"msg": DataStr("SUBJ-777 and 42")}],
        "note": "plain SUBJ-777 stays",               # plain str：永不遮蔽
    }
    masked = mask_receipt_strings(receipt, VALUES)
    assert masked["reason"] == "failed on [DATA]"
    assert masked["stdout"] == "[DATA]\n"
    assert masked["stderr"] == "ID=[DATA];"
    assert masked["environmentHint"] == "see [DATA] docs"
    assert masked["outputs"]["LISTING"]["columns"][0]["name"] == "[DATA]"
    assert masked["nested"][0]["msg"] == "[DATA] and 42"
    assert masked["note"] == "plain SUBJ-777 stays"       # plain：零误伤
    assert masked["code"] == "CODE_EXECUTION_ERROR"       # 非字符串叶子不碰
    # DataStr 通道零泄露；plain 通道按构造点口径原样（本用例模拟的是
    # "非回显面的白名单元数据"，worker 实际构造的全部值承载字段均已包 DataStr）。
    assert "SUBJ-777" not in json.dumps(
        {key: value for key, value in masked.items() if key != "note"},
        ensure_ascii=False)


def test_mask_receipt_strings_exempts_doc_payloads_by_default():
    """【旧 EXEMPT_SOURCES 豁免断言改写】doc 子树内容全是 plain str——
    豁免由"plain 永不遮蔽"默认规则自动成立（无豁免来源清单）；子树
    对象恒等（一个字节不碰）。"""
    receipt = {
        "documents": [
            {"_source": "spec-document", "content": "SUBJ-777 全量直通",
             "inner": {"note": "Headache"}},
            {"_source": "aux-excel", "rows": [["SUBJ-777", "Headache"]]},
        ],
        "datasets": [{"_source": "dataset", "name": "AE", "note": DataStr("SUBJ-777")}],
    }
    masked = mask_receipt_strings(receipt, VALUES)
    spec, aux, dataset = masked["documents"][0], masked["documents"][1], masked["datasets"][0]
    assert spec is receipt["documents"][0]                   # 豁免子树对象恒等
    assert spec["content"] == "SUBJ-777 全量直通"
    assert spec["inner"]["note"] == "Headache"               # 深层字符串同样豁免
    assert aux is receipt["documents"][1]
    assert aux["rows"] == [["SUBJ-777", "Headache"]]
    assert dataset["note"] == "[DATA]"                       # DataStr 通道照遮


def test_mask_receipt_strings_empty_values_identity():
    receipt = {"stdout": DataStr("SUBJ-777"), "list": [DataStr("Headache")]}
    assert mask_receipt_strings(receipt, frozenset()) is receipt


def test_mask_receipt_strings_reports_masked_count():
    audit: dict = {}
    masked = mask_receipt_strings(
        {"stdout": DataStr("Headache SUBJ-777"), "reason": DataStr("ok"),
         "doc": {"_source": "spec-document", "t": "Headache"}},
        VALUES, audit)
    assert masked["stdout"] == "[DATA] [DATA]"
    assert audit["maskedCount"] == 2                         # 豁免子树不计入


# ---------------------------------------------------------------------------
# BUG-K1（2026-08-30）：dict 键层遮蔽——DataStr 键遮蔽，plain 键原样
# （旧 PROTOCOL_KEYS 白名单断言改写：白名单由"构造点不标"取代中央词表）
# ---------------------------------------------------------------------------

def test_mask_receipt_strings_masks_colliding_column_name_keys():
    """BUG-K1 复现：dtypes/nullCount/uniqueCount 以列名为键（discovery
    构造点标 DataStr）——碰撞列名（= 某数据集单元格值）作键必须遮蔽为
    [DATA]，正常列名键原样；columns 列表（叶层）同遮蔽；键层命中计入
    maskedCount。"""
    receipt = {
        "inspection": {"datasets": [{
            "_source": "dataset",
            "name": "AE", "path": "AE.csv",
            "columns": [DataStr("Headache"), DataStr("PLAIN_COL")],
            "rowCount": 2,
            "dtypes": {DataStr("Headache"): "object", DataStr("PLAIN_COL"): "int64"},
            "nullCount": {DataStr("Headache"): 0, DataStr("PLAIN_COL"): 0},
            "uniqueCount": {DataStr("Headache"): 1, DataStr("PLAIN_COL"): 2},
        }]},
    }
    audit: dict = {}
    masked = mask_receipt_strings(receipt, VALUES, audit)
    dataset = masked["inspection"]["datasets"][0]
    assert dataset["columns"] == ["[DATA]", "PLAIN_COL"]     # 叶层同遮蔽
    assert dataset["dtypes"] == {"[DATA]": "object", "PLAIN_COL": "int64"}
    assert dataset["nullCount"] == {"[DATA]": 0, "PLAIN_COL": 0}
    assert dataset["uniqueCount"] == {"[DATA]": 1, "PLAIN_COL": 2}
    assert dataset["name"] == "AE" and dataset["rowCount"] == 2   # 白名单元数据原样
    assert "Headache" not in json.dumps(masked, ensure_ascii=False)
    assert audit["maskedCount"] == 4                         # 叶 1 + 键 3


def test_mask_receipt_strings_plain_keys_never_masked():
    """【旧 PROTOCOL_KEYS 断言改写】plain 键即使与值集碰撞也原样（构造点
    未标注 = 协议/白名单元数据；遮蔽协议键即破坏回执契约——既定残余
    口径）；同一内容作 DataStr 叶值照常遮蔽。"""
    values = frozenset({"rowCount", "name", "Headache"})
    receipt = {"name": DataStr("Headache"), "rowCount": DataStr("rowCount"),
               "dtypes": {DataStr("Headache"): "object"}}
    masked = mask_receipt_strings(receipt, values)
    assert set(masked) == {"name", "rowCount", "dtypes"}     # plain 键原样
    assert masked["name"] == "[DATA]"                        # DataStr 叶值照遮
    assert masked["rowCount"] == "[DATA]"
    assert list(masked["dtypes"]) == ["[DATA]"]              # DataStr 键照遮


def test_mask_receipt_strings_key_mask_collision_deterministic():
    """两 DataStr 键同遮蔽为 [DATA]：插入序后者覆盖、结果恒合法 JSON、
    两次调用逐字节一致。"""
    receipt = {"dtypes": {DataStr("Headache"): "object", DataStr("SUBJ-777"): "int64"},
               "nullCount": {DataStr("Headache"): 0, DataStr("SUBJ-777"): 1}}
    masked = mask_receipt_strings(receipt, VALUES)
    assert masked["dtypes"] == {"[DATA]": "int64"}           # 后者覆盖前者
    assert masked["nullCount"] == {"[DATA]": 1}
    assert json.dumps(masked)                                # 合法 JSON 不抛
    again = mask_receipt_strings(receipt, VALUES)
    assert json.dumps(again, ensure_ascii=False) == json.dumps(masked, ensure_ascii=False)


def test_mask_receipt_strings_doc_plain_keys_untouched():
    """doc 豁免子树：键与值均 plain（构造点不标），键层遮蔽不延伸进豁免树。"""
    receipt = {"documents": [
        {"_source": "spec-document", "Headache": "SUBJ-777"},
    ]}
    masked = mask_receipt_strings(receipt, VALUES)
    doc = masked["documents"][0]
    assert doc is receipt["documents"][0]
    assert doc["Headache"] == "SUBJ-777"                     # 键与值都不动


# ---------------------------------------------------------------------------
# 性能：1MB 文本 × 大规模值集（5万 ≤2s；20万 ≤4s，真实实测）
# ---------------------------------------------------------------------------

def test_perf_1mb_text_with_full_scale_value_set():
    single = [f"S{i:07d}" for i in range(49_000)]                # 8 字符单 token 值
    multi = [f"EVENT TYPE {i:05d}" for i in range(1000)]          # 含空格长值
    frame = _frame(single + multi)
    values, stats = build_value_set({"DS": frame})
    assert stats["selected"] == 50_000 and stats["degraded"] is False
    chunk = "row S0000001 value EVENT TYPE 00042 note id=S0000002 plain tail\n"
    text = chunk * (1_048_576 // len(chunk) + 1)
    assert len(text) >= 1_048_576
    start = time.monotonic()
    masked = mask_text(text, values)
    elapsed = time.monotonic() - start
    assert elapsed <= 2.0, f"mask_text 1MB × 满规模值集耗时 {elapsed:.2f}s"
    assert "S0000001" not in masked and "S0000002" not in masked
    assert "EVENT TYPE 00042" not in masked
    assert masked.count("[DATA]") == 3 * (1_048_576 // len(chunk) + 1)


def test_perf_1mb_text_with_200k_value_set_under_4s():
    """BUG-R1 配套：上限提至 1M 后 20 万值集是现实负载档（真实项目
    distinct 5 万+），1MB 文本全量遮蔽 ≤4s（真实实测，不许砍语义）。"""
    single = [f"T{i:07d}" for i in range(199_000)]               # 8 字符单 token 值
    multi = [f"EVENT TYPE {i:05d}" for i in range(1000)]          # 含空格长值
    frame = _frame(single + multi)
    values, stats = build_value_set({"DS": frame})
    assert stats == {"total": 200_000, "selected": 200_000,
                     "degraded": False, "dropped": 0}             # 20万 < 默认 1M 不降级
    chunk = "row T0000001 value EVENT TYPE 00042 note id=T0000002 plain tail\n"
    text = chunk * (1_048_576 // len(chunk) + 1)
    assert len(text) >= 1_048_576
    start = time.monotonic()
    masked = mask_text(text, values)
    elapsed = time.monotonic() - start
    assert elapsed <= 4.0, f"mask_text 1MB × 20万值集耗时 {elapsed:.2f}s"
    assert "T0000001" not in masked and "T0000002" not in masked
    assert "EVENT TYPE 00042" not in masked
    assert masked.count("[DATA]") == 3 * (1_048_576 // len(chunk) + 1)


# ---------------------------------------------------------------------------
# 预编译 ValueMatcher：索引化，遮蔽 O(文本) 与值数无关
# ---------------------------------------------------------------------------

def test_compile_matcher_stats_and_truthiness():
    """【旧 stats 断言改写】compile_matcher 编译出值集 + 前缀桶索引 +
    归一化形态集（canonForms）；空值集 falsy。"""
    matcher = compile_matcher(VALUES)
    assert matcher                                              # 非空值集 truthy
    assert matcher.values == VALUES
    assert matcher.stats["values"] == len(VALUES)               # 4 值全量
    assert matcher.stats["prefixBuckets"] == 4                  # 4 个独立前缀桶
    assert matcher.stats["canonForms"] == 0                     # 无数字引导值
    assert not compile_matcher(frozenset())                     # 空值集 falsy
    assert compile_matcher(matcher) is matcher                  # 幂等：matcher 直传原样


def test_mask_text_accepts_matcher_equivalent_to_legacy_values():
    """同一文本走 matcher 与旧 frozenset 签名结果逐字节一致（统一滑窗语义）。"""
    matcher = compile_matcher(VALUES)
    texts = [
        "SUBJ-777 出现 Headache",
        '(Headache); "SUBJ-777",',
        "ID=SUBJ-777;",
        "a,Headache]b",
        "dx=Myocardial Infarction;grade=3",
        "Myocardial Infarction",
        "a  SUBJ-777\n\nb\tHeadache",
        "abc123",
        "x=abc123;",
        "无命中 plain text 2024-01-01 正常文本",
        "",
    ]
    for text in texts:
        assert mask_text(text, matcher) == mask_text(text, VALUES)


def test_mask_text_legacy_frozenset_caches_by_identity():
    """兼容旧签名：frozenset 传入按对象身份缓存编译（强引用钉住身份），
    同一对象二次调用命中缓存不重编；行为与直接编译一致。"""
    import value_mask
    assert mask_text("SUBJ-777", VALUES) == "[DATA]"
    assert value_mask._MATCHER_CACHE is not None
    assert value_mask._MATCHER_CACHE[0] is VALUES
    assert mask_text("Headache", VALUES) == "[DATA]"
    assert value_mask._MATCHER_CACHE[0] is VALUES             # 仍是同对象 → 缓存命中


def test_mask_receipt_strings_accepts_matcher():
    """mask_receipt_strings 同样接受 matcher（worker 缓存路径）。"""
    matcher = compile_matcher(VALUES)
    receipt = {"stdout": DataStr("Headache SUBJ-777"), "nested": {"k": DataStr("ID=SUBJ-777;")}}
    audit: dict = {}
    masked = mask_receipt_strings(receipt, matcher, audit)
    assert masked["stdout"] == "[DATA] [DATA]"
    assert masked["nested"]["k"] == "ID=[DATA];"
    assert audit["maskedCount"] == 3
    assert mask_receipt_strings(receipt, compile_matcher(frozenset())) is receipt


def test_multiword_high_shared_prefix_exact_no_false_positive():
    """多词值高共享前缀（全部同落一个前缀桶）仍精确遮蔽：同前缀不同值、
    同前缀截断形态零误遮（索引化的正确性靶）。"""
    values = frozenset({
        "COMMON PREFIX VALUE 000001",
        "COMMON PREFIX VALUE 000002",
        "COMMON PREFIX VANISH 000001",
    })
    matcher = compile_matcher(values)
    assert matcher.stats["prefixBuckets"] == 1                 # 三值共享 "COMM" 同桶
    assert mask_text("a COMMON PREFIX VALUE 000001 b", matcher) == "a [DATA] b"
    assert mask_text("COMMON PREFIX VANISH 000001", matcher) == "[DATA]"
    assert mask_text("dx=COMMON PREFIX VALUE 000002;", matcher) == "dx=[DATA];"
    assert mask_text("COMMON PREFIX VALUE 000001 end", matcher) == "[DATA] end"
    # 同前缀不同值 / 前缀截断：零误遮
    assert mask_text("COMMON PREFIX OTHER 000001", matcher) == "COMMON PREFIX OTHER 000001"
    assert mask_text("COMMON PREFIX VALUE 000003", matcher) == "COMMON PREFIX VALUE 000003"
    assert mask_text("COMMON PREFIX VALU", matcher) == "COMMON PREFIX VALU"
    assert mask_text("COMMON P", matcher) == "COMMON P"


# ---------------------------------------------------------------------------
# 性能靶（合成，2026-08-30）：100 万值集（多词 20 万高共享前缀）真实负载档
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def million_scale():
    """100 万值集（80 万单词 + 20 万多词全部共享前缀 "COMMON P"）+ matcher。
    模块级共享：构建一次，三个性能靶复用；compileSeconds 供构建靶断言。"""
    single = [f"S{i:07d}" for i in range(800_000)]                    # 8 字符单 token 值
    multi = [f"COMMON PREFIX VALUE {i:06d}" for i in range(200_000)]   # 多词同前缀干扰
    values, stats = build_value_set({"DS": _frame(single + multi)})
    assert stats == {"total": 1_000_000, "selected": 1_000_000,
                     "degraded": False, "dropped": 0}
    start = time.monotonic()
    matcher = compile_matcher(values)
    elapsed = time.monotonic() - start
    assert matcher.stats["values"] == 1_000_000
    # 【重构改写】统一 4 字符前缀桶：单词值共享 "S000".."S079" 共 80 桶
    # + 多词 "COMM" 1 桶（旧 8 字符双桶体系是 800_001 桶）。
    assert matcher.stats["prefixBuckets"] == 81
    return {"values": values, "matcher": matcher, "compileSeconds": elapsed}


def test_perf_compile_1m_values_under_10s(million_scale):
    """构建靶：100 万值集编译 ≤10s。"""
    assert million_scale["compileSeconds"] <= 10.0, \
        f"100 万值集编译耗时 {million_scale['compileSeconds']:.2f}s"


def test_perf_1mb_text_1m_values_under_4s(million_scale):
    """遮蔽靶：100 万值集（多词 20 万高共享前缀）× 1MB 文本统一滑窗
    全量遮蔽 ≤4s，且同前缀干扰串零误遮——遮蔽耗时与值集规模无关。"""
    matcher = million_scale["matcher"]
    chunk = ("row S0000001 v COMMON PREFIX VALUE 000042 id=S0000002 "
             "noise COMMON PREFIX VALU no-hit tail\n")
    repeats = 1_048_576 // len(chunk) + 1
    text = chunk * repeats
    assert len(text) >= 1_048_576
    start = time.monotonic()
    masked = mask_text(text, matcher)
    elapsed = time.monotonic() - start
    assert elapsed <= 4.0, f"1MB × 100万值集耗时 {elapsed:.2f}s"
    assert "S0000001" not in masked and "S0000002" not in masked
    assert "COMMON PREFIX VALUE 000042" not in masked
    assert masked.count("[DATA]") == 3 * repeats                     # 每块 3 命中全遮
    assert "COMMON PREFIX VALU " in masked                           # 同前缀干扰串不误遮


def test_perf_small_leaf_500_chars_under_20ms(million_scale):
    """小叶子靶：500 字符回执叶子（inspect 上万叶子的单叶负载）单次
    mask_text ≤20ms——run_code 单请求 ≤2s 的微观前提。"""
    matcher = million_scale["matcher"]
    leaf = ("cell S0000001 x COMMON PREFIX VALU noise COMMON PREFIX VALUE 000007 y "
            * 8)[:500]
    assert len(leaf) == 500
    start = time.monotonic()
    masked = mask_text(leaf, matcher)
    elapsed = time.monotonic() - start
    assert elapsed <= 0.020, f"500 字符叶子耗时 {elapsed * 1000:.1f}ms"
    assert "S0000001" not in masked and "COMMON PREFIX VALUE 000007" not in masked


# ---------------------------------------------------------------------------
# datetime 显示变体（C1 保持）——变体入库 + stats 原始值口径
# ---------------------------------------------------------------------------

def test_datetime_display_variants_enter_value_set():
    """C1 根因复现：datetime 列只按 str 入集时，表格打印形态（毫秒 3 位 /
    秒级 / 日期-only / isoformat）整段出域——修复后四种显示变体全部入库，
    stats 仍按原始值计数（变体不重复计数）。"""
    ts = pd.Timestamp("2024-01-15 10:30:00.713456")
    midnight = pd.Timestamp("2024-02-01 00:00:00")
    frame = pd.DataFrame({"VISITDT": [ts, midnight]})
    values, stats = build_value_set({"DS": frame})
    assert str(ts) in values                          # 原始 str 形态（微秒 6 位）
    assert "2024-01-15 10:30:00.713" in values        # 表格毫秒 3 位形态
    assert "2024-01-15 10:30:00" in values            # 秒级形态
    assert "2024-01-15" in values                     # 日期-only 形态（零点列）
    assert ts.isoformat() in values                   # isoformat 形态
    assert stats == {"total": 2, "selected": 2, "degraded": False, "dropped": 0}


def test_datetime_variants_survive_cap_and_respect_len4(monkeypatch):
    """变体受 len>=4 与上限降级规则约束：超上限截断时只保留入选原始值的
    变体（丢弃值的变体一并丢弃）。"""
    monkeypatch.setenv(VALUE_SET_MAX_ENV, "1")
    keep = pd.Timestamp("2024-01-15 10:30:00.713456")
    drop = pd.Timestamp("2025-06-30 22:15:00.999888")
    frame = pd.DataFrame({"A": [keep, drop, drop]})   # drop 频次更高必入集
    values, stats = build_value_set({"DS": frame})
    assert stats["selected"] == 1 and stats["degraded"] is True
    assert str(drop) in values and "2025-06-30 22:15:00.999" in values
    assert str(keep) not in values and "2024-01-15" not in values   # 落选值变体不入集


def test_datetime_millisecond_table_print_masked_in_stdout():
    """C1 端到端复现：head 表格打印毫秒 3 位形态（str 是微秒 6 位，修复前
    整段时间戳列 stdout 出域）——修复后经变体入库遮蔽为 [DATA]。"""
    ts = pd.Timestamp("2024-01-15 10:30:00.713456")
    frame = pd.DataFrame({"VISITDT": [ts]})
    values, _stats = build_value_set({"DS": frame})
    stdout = str(frame.head(1))                       # 真实表格打印形态
    assert "2024-01-15 10:30:00.713" in stdout        # 复现前提：确为毫秒形态
    masked = mask_receipt_strings({"stdout": DataStr(stdout)}, values)
    assert "2024-01-15" not in masked["stdout"]       # 任何 datetime 显示形态不出域
    assert "10:30:00" not in masked["stdout"]
    assert masked["stdout"].count("[DATA]") == 1
    assert masked["stdout"].count("VISITDT") == 1     # 列名原样（零误伤）


# ---------------------------------------------------------------------------
# 统一通道（2026-08-30 重构）：DataStr 内容统一 len>=4 滑窗 + 归一化；
# plain 内容零处理（旧 SOFT_KEYS 边界断言按新架构改写）
# ---------------------------------------------------------------------------

def test_uniform_channel_masks_short_multiword_in_content():
    """【旧 SOFT_KEYS C2 断言改写】4-7 字符两词值在 DataStr 内容（stdout
    等）由统一滑窗兜住；同一内容 plain（白名单元数据/文档内容）零处理。"""
    values = frozenset({"MILD 1"})
    masked = mask_receipt_strings(
        {"stdout": DataStr("   AETOXGR\n0  MILD 1\n")}, values)
    assert masked["stdout"] == "   AETOXGR\n0  [DATA]\n"
    plain = mask_receipt_strings({"note": "a MILD 1 b"}, values)
    assert plain["note"] == "a MILD 1 b"              # plain：构造点未标注，零处理


def test_uniform_channel_masks_repr_wrapped_short_value():
    """【旧 SOFT_KEYS C3 断言改写】repr/格式化包裹的 4-7 字符值（单 token
    内嵌入，如 np.float64(12.5) 打印形态）——全部回显字段（DataStr）兜住。"""
    values = frozenset({"12.5"})
    masked = mask_receipt_strings({"stdout": DataStr("np.float64(12.5)\n")}, values)
    assert masked["stdout"] == "np.float64([DATA])\n"
    for key in ("stderr", "reason", "traceback", "environmentHint"):
        receipt = mask_receipt_strings({key: DataStr("err on 12.5;")}, values)
        assert receipt[key] == "err on [DATA];"       # 单侧尾标点保留


def test_datastr_columns_and_names_masked_in_structural_fields():
    """结构面（columns 列表 / outputs 表名与列名 / dtypes 键）在构造点
    标 DataStr——统一通道对走私值照遮（A-4/E-3 攻击面的新架构语义）。"""
    values = frozenset({"MILD 1", "12.5"})
    receipt = {
        "columns": [DataStr("MILD 1"), DataStr("GRADE")],
        "outputs": {DataStr("MILD 1"): {"columns": [{"name": DataStr("x12.5y")}]}},
    }
    masked = mask_receipt_strings(receipt, values)
    assert masked["columns"] == ["[DATA]", "GRADE"]
    assert list(masked["outputs"]) == ["[DATA]"]
    assert masked["outputs"]["[DATA]"]["columns"][0]["name"] == "x[DATA]y"


def test_soft_mask_no_placeholder_corruption():
    """值恰为占位符子串（如 'DATA'）时不得连环改写占位符本身：span 式替换
    保证 [DATA] 不被二次命中。"""
    values = frozenset({"DATA", "DATA NOTE", "NOTE"})
    masked = mask_receipt_strings({"stdout": DataStr("DATA NOTE and DATA")}, values)
    assert masked["stdout"] == "[DATA] and [DATA]"
    assert "[[DATA]]" not in masked["stdout"]


def test_perf_uniform_channel_1mb_text_200k_values_under_4s():
    """性能：统一滑窗（4 字符窗 + 归一化）不劣化——1MB stdout × 20 万
    值集 ≤4s 档复测（索引化后遮蔽耗时与值集规模无关）。"""
    single = [f"T{i:07d}" for i in range(199_000)]                # 8 字符单 token 值
    multi = [f"EVENT TYPE {i:05d}" for i in range(1000)]          # 含空格长值
    values, stats = build_value_set({"DS": _frame(single + multi)})
    assert stats == {"total": 200_000, "selected": 200_000,
                     "degraded": False, "dropped": 0}
    matcher = compile_matcher(values)
    chunk = "row T0000001 value EVENT TYPE 00042 note id=T0000002 plain tail\n"
    repeats = 1_048_576 // len(chunk) + 1
    text = chunk * repeats
    assert len(text) >= 1_048_576
    start = time.monotonic()
    masked = mask_text(text, matcher)
    elapsed = time.monotonic() - start
    assert elapsed <= 4.0, f"统一通道 1MB × 20万值集耗时 {elapsed:.2f}s"
    assert "T0000001" not in masked and "T0000002" not in masked
    assert "EVENT TYPE 00042" not in masked
    assert masked.count("[DATA]") == 3 * repeats
