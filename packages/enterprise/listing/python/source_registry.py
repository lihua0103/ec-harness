"""数据源头标注——数据拦截的判定锚点（2026-08-28 第三版口径，ADR-0007）。

拦截只依据"数据从哪里来"（见 data_guard.PROJECTION），绝不依据字段名：
字段黑名单易被改名绕过，源头无法绕过。**唯一被投影的载荷**是
``dataset``（数据集原始行值）；``aux-excel``（doc/ 辅助 Excel）自
2026-08-28 起退役出投影表——doc/ 零拦截，标记仅作审计溯源；
``spec-document`` / ``model-output`` 同样直通。

``tag_dataframe`` **不在 sandbox 命名空间暴露**（审计 P1-1：源头标记不
可由模型重贴）。

``DataStr``（2026-08-30 系统级重构）：回执字符串的**构造期车道标记**——
只有回执构造点知道一个字符串的来源，值遮蔽（value_mask）的唯一判定
依据。中央白名单体系（PROTOCOL_KEYS/SOFT_KEYS/豁免来源清单）已全部
删除，规则收敛为：DataStr 叶子/键 → 遮蔽；plain str → 永不遮蔽。
"""
from dataclasses import dataclass
from enum import Enum
from typing import Any, Optional, Union

import pandas as pd

SOURCE_ATTR = "_source"


class DataStr(str):
    """数据集派生 / AI 回显面字符串（回执遮蔽车道标记）。

    车道规则（详见 AGENTS.md「数据拦截」）：凡数据集派生或模型可控回显
    的回执字符串，**构造点**一律包 ``DataStr``——

    - discovery：columns 列表、dtypes/nullCount/uniqueCount/profile/sample
      的列名键、失败 reason、profile 格式模式串；
    - worker：stdout/stderr/reason/traceback/environmentHint 五个自由文本
      字段（恒 content 类）、outputs 表名与列名；
    - excel：publish statistics 的 sheetNames（= outputs 表名）。

    其余（协议词、name/path/rowCount 等白名单元数据、doc/ 文档内容）保持
    plain str 永不遮蔽——doc 子树豁免因此由默认规则自动成立，无需豁免
    清单。json 序列化时就是普通 str，协议零变化。

    新增回执字段的默认方向是 plain（不遮）——不安全方向，故新增任何可能
    携带数据集值/回显文本的字段时**必须**在构造点包 DataStr。
    """

    __slots__ = ()


class DataSource(str, Enum):
    """数据源头。只有 dataset 在 data_guard.PROJECTION 投影表里。"""

    DATASET = "dataset"              # 唯一投影场景：sas7bdat/xpt/csv（含归档解出）的原始数据
    AUX_EXCEL = "aux-excel"          # doc/ 下的 xlsx/xls/xlsm（审计标记；不在投影表 = 直通）
    SPEC_DOCUMENT = "spec-document"  # doc/ 文本（审计标记；不在投影表 = 全量放行）
    MODEL_OUTPUT = "model-output"    # AI 产物（含 sandbox 内衍生）→ passthrough


SourceLike = Union[DataSource, str]


def normalize_source(value: SourceLike) -> str:
    """规范化源头标记；未知值立即抛错（fail-closed，不静默归为放行）。"""
    if isinstance(value, DataSource):
        return value.value
    try:
        return DataSource(value).value
    except ValueError as exc:
        raise ValueError(f"UNKNOWN_DATA_SOURCE: {value!r}") from exc


def tag_dataframe(frame: pd.DataFrame, source: SourceLike) -> pd.DataFrame:
    """给 DataFrame 标记数据源头（程序内部使用，不进 sandbox 命名空间）。"""
    frame.attrs[SOURCE_ATTR] = normalize_source(source)
    return frame


def tag_payload(payload: dict, source: SourceLike) -> dict:
    """给进入回执的 dict 载荷标记数据源头（原地标记并返回）。"""
    payload[SOURCE_ATTR] = normalize_source(source)
    return payload


def derived_from(frame: pd.DataFrame) -> pd.DataFrame:
    """AI 在 sandbox 内 merge/groupby/filter 出的 df——继承源头。

    原始源头（如 dataset）继续生效：衍生数据同样不允许把行值带出域；
    无源头可继承时标记为 model-output（AI 自己的产物，放行）。
    """
    derived = frame.copy()
    derived.attrs[SOURCE_ATTR] = frame.attrs.get(SOURCE_ATTR, DataSource.MODEL_OUTPUT.value)
    return derived


def source_of(value: Any) -> Optional[str]:
    """读取 DataFrame / 载荷 dict 的源头标记；没有则 None。"""
    attrs = getattr(value, "attrs", value)
    if not isinstance(attrs, dict):
        return None
    source = attrs.get(SOURCE_ATTR)
    return source if isinstance(source, str) else None


@dataclass(frozen=True)
class SourceTag:
    """回执子树上的源头标记（serde 友好形态）。"""

    source: str

    @classmethod
    def of(cls, source: SourceLike) -> "SourceTag":
        return cls(source=normalize_source(source))
