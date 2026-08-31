"""列级语义画像（profile，2026-08-30 系统级重构 C 支柱）靶场。

"零瞎"验收三件套（全部合成数据，禁止任何真实项目值进测试）：

1. **推断口径**：值形态类（date-like/categorical/numeric/identifier-like/
   free-text/boolean）与格式模式骨架（YYYY-MM-DD 族/A####-#### 族等）由
   采样统计推断，确定性（同数据两次画像逐字节一致）。
2. **AI 能力用例**：仅凭 receipt.profile（不看行值）判定日期列格式并
   生成正确解析代码——证明遮蔽行值后 AI 不瞎。
3. **泄漏断言**：profile 序列化后与真值集交集为 0；模式骨架自指边界
   （骨架恰为某单元格值）由 DataStr 通道兜住。
"""
import json

import pandas as pd

from source_registry import DataStr
from value_mask import build_value_set, mask_receipt_strings


def _study_frame(rows: int = 100) -> pd.DataFrame:
    """合成研究数据：标识符 / ISO 日期 / SAS 日期 / 类别 / 数值 / 布尔 /
    自由文本 七类列。"""
    return pd.DataFrame({
        "USUBJID": [f"AB1234-{i:04d}" for i in range(rows)],
        "AESTDTC": [f"2026-{(i % 12) + 1:02d}-{(i % 27) + 1:02d}" for i in range(rows)],
        "TRTSDT": [f"{(i % 27) + 1:02d}JAN{(2020 + i % 6)}" for i in range(rows)],
        "SEX": ["F" if i % 2 else "M" for i in range(rows)],
        "AGE": [20 + i % 50 for i in range(rows)],
        "FLG": [i % 2 == 0 for i in range(rows)],
        "COMMENT": [f"subject note number {i} with free text" for i in range(rows)],
    })


# ---------------------------------------------------------------------------
# 推断口径：形态类与模式骨架
# ---------------------------------------------------------------------------

def test_profile_shapes_and_patterns():
    frame = _study_frame()
    from discovery import dataset_payloads
    payload = dataset_payloads({"STUDY": frame}, {"STUDY": "study.csv"},
                               with_sample=False)[0]
    profile = payload["profile"]
    assert set(profile) == set(frame.columns)                  # 列全覆盖
    assert profile["USUBJID"]["shape"] == "identifier-like"
    assert profile["USUBJID"]["pattern"] == "AA####-####"      # AB1234-0000 形状
    assert profile["AESTDTC"]["shape"] == "date-like"
    assert profile["AESTDTC"]["pattern"] == "####-##-##"       # YYYY-MM-DD 族
    assert profile["TRTSDT"]["shape"] == "date-like"
    assert profile["TRTSDT"]["pattern"] == "##AAA####"         # DDMMMYYYY（SAS 风格）
    assert profile["SEX"]["shape"] == "categorical"
    assert profile["SEX"]["sampleUniqueCount"] == 2
    assert profile["AGE"]["shape"] == "numeric"
    assert profile["FLG"]["shape"] == "boolean"
    assert profile["COMMENT"]["shape"] == "free-text"


def test_profile_datetime64_column():
    """datetime64 列：日期-only（全零点）/ 带时间两档骨架。"""
    from discovery import _column_profile
    date_only = _column_profile(pd.Series(pd.to_datetime(["2026-01-15", "2026-02-20"])))
    assert date_only["shape"] == "date-like" and date_only["pattern"] == "####-##-##"
    with_time = _column_profile(pd.Series(pd.to_datetime(["2026-01-15 08:30:00"])))
    assert with_time["pattern"] == "####-##-## ##:##:##"


def test_profile_deterministic_and_capped_probe():
    """同数据两次画像逐字节一致；大表采样上限 1000 行（确定性列头采样）。"""
    from discovery import PROFILE_PROBE_ROWS, dataset_payloads
    frame = _study_frame(rows=50)
    first = dataset_payloads({"S": frame}, {"S": "s.csv"})[0]["profile"]
    second = dataset_payloads({"S": frame}, {"S": "s.csv"})[0]["profile"]
    assert json.dumps(first, default=str) == json.dumps(second, default=str)
    wide = _study_frame(rows=PROFILE_PROBE_ROWS + 500)
    assert all(info["sampled"] <= PROFILE_PROBE_ROWS
               for info in dataset_payloads({"W": wide}, {"W": "w.csv"})[0]["profile"].values())


def test_profile_empty_and_mixed_columns():
    from discovery import _column_profile
    assert _column_profile(pd.Series([], dtype=object))["shape"] == "empty"
    assert _column_profile(pd.Series([None, None]))["shape"] == "empty"
    mixed = _column_profile(pd.Series(["note a", "totally different shape", "x1"]))
    assert mixed["shape"] in {"free-text", "categorical"}      # 混合骨架不武断定型
    assert "pattern" not in mixed                              # 不稳定 → 无模式


# ---------------------------------------------------------------------------
# AI 能力用例：仅凭 profile 生成正确解析代码（零瞎证明）
# ---------------------------------------------------------------------------

_SKELETON_TO_STRPTIME = {
    "####-##-##": "%Y-%m-%d",
    "##/##/####": "%m/%d/%Y",
    "##AAA####": "%d%b%Y",
    "####-##-## ##:##:##": "%Y-%m-%d %H:%M:%S",
}


def test_ai_can_parse_date_column_from_profile_only():
    """脚本化 AI 能力：不看任何行值，仅凭 receipt.profile 的 pattern 生成
    pd.to_datetime 解析代码并正确解析合成日期——遮蔽行值不降智。"""
    from discovery import dataset_payloads
    frame = _study_frame(rows=30)
    payload = dataset_payloads({"STUDY": frame}, {"STUDY": "s.csv"}, with_sample=False)[0]
    receipt_profile = json.loads(json.dumps(payload["profile"]))   # 出域形态（纯 JSON）
    # AI 的格式判定：骨架 → strptime 格式串（仅凭 profile，零行值输入）
    decisions = {column: _SKELETON_TO_STRPTIME[info["pattern"]]
                 for column, info in receipt_profile.items()
                 if info.get("shape") == "date-like"}
    assert decisions == {"AESTDTC": "%Y-%m-%d", "TRTSDT": "%d%b%Y"}
    # 生成的解析代码在合成日期上正确工作（等价于 AI 写出的 to_datetime 行）
    assert str(pd.to_datetime("2026-03-05", format=decisions["AESTDTC"]).date()) == "2026-03-05"
    assert str(pd.to_datetime("05MAR2026", format=decisions["TRTSDT"]).date()) == "2026-03-05"


def test_zero_blind_information_metrics():
    """零瞎验证：模拟回执（profile + doc）信息量——列覆盖率 100%，类型化
    列（date/identifier/类别编码）格式可判定率达标；行值仍零出域。"""
    from discovery import dataset_payloads
    frame = _study_frame(rows=40)
    payload = dataset_payloads({"STUDY": frame}, {"STUDY": "s.csv"}, with_sample=False)[0]
    profile = payload["profile"]
    columns = payload["columns"]
    assert len(profile) == len(columns) == len(frame.columns)
    coverage = len(profile) / len(columns)
    assert coverage == 1.0                                     # 列覆盖率
    formatable = [name for name, info in profile.items()
                  if info.get("shape") in {"date-like", "identifier-like"}
                  and "pattern" in info]
    determinable = len(formatable) / len([1 for info in profile.values()
                                          if info.get("shape") in {"date-like", "identifier-like"}])
    assert determinable == 1.0                                 # 格式可判定率
    assert payload["rowCount"] == 40                           # 规模感在场
    assert "sample" not in payload                             # 行样本仍不构建


# ---------------------------------------------------------------------------
# 泄漏断言：profile 与真值集交集为 0；自指边界由 DataStr 兜住
# ---------------------------------------------------------------------------

def test_profile_serialized_has_zero_intersection_with_values():
    """profile 序列化文本与数据集真值集零交集（骨架/形态词/计数不含值）。"""
    from discovery import dataset_payloads
    frame = _study_frame(rows=40)
    payload = dataset_payloads({"STUDY": frame}, {"STUDY": "s.csv"}, with_sample=False)[0]
    values, _stats = build_value_set({"STUDY": frame})
    profile_text = json.dumps(payload["profile"], ensure_ascii=False)
    leaked = [value for value in values if len(value) >= 6 and value in profile_text]
    assert leaked == [], f"profile 泄漏真值: {leaked}"


def test_profile_pattern_self_reference_masked():
    """自指边界：某单元格值恰为骨架串（如 '####-##-##'）——pattern 构造点
    已标 DataStr，值遮蔽把该 pattern 遮为 [DATA]（不另设中央清单）。"""
    from discovery import dataset_payloads
    frame = pd.DataFrame({
        "DT": ["2026-01-15", "2026-02-20"],
        "PATHOLOGICAL": ["####-##-##", "plain-value"],     # 单元格值 = 骨架串本身
    })
    payload = dataset_payloads({"S": frame}, {"S": "s.csv"}, with_sample=False)[0]
    values, _stats = build_value_set({"S": frame})
    masked = mask_receipt_strings({"inspection": {"datasets": [payload]}}, values)
    pattern = masked["inspection"]["datasets"][0]["profile"]["DT"]["pattern"]
    assert pattern == "[DATA]"                               # 自指骨架被遮蔽
    shape = masked["inspection"]["datasets"][0]["profile"]["DT"]["shape"]
    assert shape == "date-like"                              # 判型词汇不受影响


def test_profile_column_keys_are_datastr_and_masked_on_collision():
    """profile 列名键在构造点标 DataStr：碰撞列名（= 单元格值）遮蔽，
    正常列名键原样（与 BUG-K1 键层语义一致）。"""
    from discovery import dataset_payloads
    frame = pd.DataFrame({"NOTE": ["2026-01-15"], "DESC": ["collides?"]})
    frame.loc[len(frame)] = ["NOTE", "other"]               # 单元格值恰为列名 NOTE
    payload = dataset_payloads({"S": frame}, {"S": "s.csv"}, with_sample=False)[0]
    values, _stats = build_value_set({"S": frame})
    masked = mask_receipt_strings({"inspection": {"datasets": [payload]}}, values)
    dataset = masked["inspection"]["datasets"][0]
    assert list(dataset["profile"]) == ["[DATA]", "DESC"]
    assert list(dataset["dtypes"]) == ["[DATA]", "DESC"]
    assert dataset["columns"] == ["[DATA]", "DESC"]
    assert "NOTE" not in json.dumps(masked, ensure_ascii=False)
    # DataStr 键序列化为普通 str（协议零破坏）
    assert isinstance(dataset["profile"]["DESC"], dict)
    assert json.dumps(masked, ensure_ascii=False)           # 合法 JSON 不抛


def test_profile_values_are_json_primitive_types():
    """profile 出域形态只含 str/int（DataStr 序列化即 str），无对象残留。"""
    from discovery import dataset_payloads
    payload = dataset_payloads({"S": _study_frame(10)}, {"S": "s.csv"})[0]
    serialized = json.dumps(payload["profile"], ensure_ascii=False)
    revived = json.loads(serialized)
    for info in revived.values():
        for field, value in info.items():
            assert isinstance(value, (str, int)), (field, type(value))
