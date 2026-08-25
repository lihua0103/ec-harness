"""Per-project listing 配置词表。

场景推断、spec 文档分类、复核列与目录页模板等词表历史上硬编码自单个项目
的文件命名与交付模板。此处把词表收敛为带默认值的 ProjectProfile：默认值
与原硬编码完全一致；项目可在 `<project>/.clinical-listing/listing-profile.json`
覆写任一字段（.clinical-listing 已被 DatasetCatalog 排除，不会索引为数据
集），或由 EMERALD_LISTING_PROFILE 指定显式配置路径（运维侧环境变量）。
配置非法时逐字段回退默认值并记录 warning，不阻断工作流。
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from security.listing_plan import REVIEW_COLUMNS, SCENARIOS

PROFILE_ENV_VAR = "EMERALD_LISTING_PROFILE"
PROFILE_RELATIVE_PATH = Path(".clinical-listing") / "listing-profile.json"
PROFILE_INVALID_WARNING = "the project listing profile is invalid; defaults were applied"

DEFAULT_SPEC_DIRECTORY = "doc"
DEFAULT_SCENARIO = "report"
DEFAULT_SCENARIO_KEYWORDS: dict[str, tuple[str, ...]] = {
    "report": ("report", "status", "rt01"),
    "medical": ("medical", "ae", "adverse"),
    "rbqm": ("rbqm", "quality", "kri", "test_final"),
    "manual": ("manual", "review", "data validation plan", "数据核查计划"),
}
DEFAULT_SPEC_KEYWORDS = ("spec", "listing", "核查计划", "validation plan", "manual", "test_final")
DEFAULT_REPORT_SUPPORT_KEYWORDS = ("crviewer", "page_details", "query_details", "prod", "odm", "报表明细")
DEFAULT_CONTENTS_HEADERS = (
    "Listing Seq.", "Listing Name(Please Click Down)", "Data Set Label",
    "Report Description", "New/Modified ?", "Total Row Count", "New Count",
    "Modified Count",
)
DEFAULT_CONTENTS_SHEET_NAME = "Contents"
DEFAULT_STATUS_COLUMN = "status"

_MAX_KEYWORDS = 64
_MAX_KEYWORD_CHARS = 64
_MAX_REVIEW_COLUMNS = 32
_MAX_CONTENTS_HEADERS = 16
_SHEET_NAME_CHARS = re.compile(r"[\\/*?:\[\]]")
_FORMULA_PREFIXES = ("=", "+", "-", "@")


@dataclass(frozen=True)
class ProjectProfile:
    spec_directory: str = DEFAULT_SPEC_DIRECTORY
    default_scenario: str = DEFAULT_SCENARIO
    scenario_keywords: dict[str, tuple[str, ...]] = field(
        default_factory=lambda: dict(DEFAULT_SCENARIO_KEYWORDS)
    )
    spec_keywords: tuple[str, ...] = DEFAULT_SPEC_KEYWORDS
    report_support_keywords: tuple[str, ...] = DEFAULT_REPORT_SUPPORT_KEYWORDS
    review_columns: dict[str, str] = field(default_factory=lambda: dict(REVIEW_COLUMNS))
    contents_headers: tuple[str, ...] = DEFAULT_CONTENTS_HEADERS
    contents_sheet_name: str = DEFAULT_CONTENTS_SHEET_NAME
    status_column_name: str = DEFAULT_STATUS_COLUMN
    warnings: tuple[str, ...] = ()


def _keywords(value: object) -> tuple[str, ...] | None:
    if not isinstance(value, list):
        return None
    return tuple(
        str(item).strip().casefold()[:_MAX_KEYWORD_CHARS]
        for item in value
        if str(item).strip()
    )[:_MAX_KEYWORDS]


def _plain_text(value: object, limit: int) -> str | None:
    text = str(value or "").strip()
    if not text or len(text) > limit or text.lstrip().startswith(_FORMULA_PREFIXES):
        return None
    return text


def _review_columns(value: object) -> dict[str, str] | None:
    if not isinstance(value, dict) or not value or len(value) > _MAX_REVIEW_COLUMNS:
        return None
    columns: dict[str, str] = {}
    for name, label in value.items():
        clean_name = _plain_text(name, 128)
        clean_label = _plain_text(label, 256)
        if clean_name is None or clean_label is None:
            return None
        columns[clean_name] = clean_label
    return columns


def _contents_headers(value: object) -> tuple[str, ...] | None:
    if not isinstance(value, list) or not value or len(value) > _MAX_CONTENTS_HEADERS:
        return None
    headers = tuple(_plain_text(item, 256) for item in value)
    if any(header is None for header in headers):
        return None
    return headers  # type: ignore[return-value]


def _contents_sheet_name(value: object) -> str | None:
    text = _plain_text(value, 31)
    if text is None or _SHEET_NAME_CHARS.search(text):
        return None
    return text


def _spec_directory(value: object) -> str | None:
    text = _plain_text(value, 64)
    if text is None or text in {".", ".."} or "/" in text or "\\" in text:
        return None
    return text


def _from_mapping(raw: dict) -> ProjectProfile:
    invalid = False

    def pick(key: str, sanitize, default):
        nonlocal invalid
        if key not in raw:
            return default
        cleaned = sanitize(raw[key])
        if cleaned is None:
            invalid = True
            return default
        return cleaned

    scenario_keywords = dict(DEFAULT_SCENARIO_KEYWORDS)
    raw_scenarios = raw.get("scenarioKeywords")
    if raw_scenarios is not None:
        if isinstance(raw_scenarios, dict) and all(key in SCENARIOS for key in raw_scenarios):
            for scenario, terms in raw_scenarios.items():
                cleaned = _keywords(terms)
                if cleaned is None:
                    invalid = True
                else:
                    scenario_keywords[scenario] = cleaned
        else:
            invalid = True
    default_scenario = pick(
        "defaultScenario",
        lambda value: str(value).strip().casefold() if str(value).strip().casefold() in SCENARIOS else None,
        DEFAULT_SCENARIO,
    )
    return ProjectProfile(
        spec_directory=pick("specDirectory", _spec_directory, DEFAULT_SPEC_DIRECTORY),
        default_scenario=default_scenario,
        scenario_keywords=scenario_keywords,
        spec_keywords=pick("specKeywords", _keywords, DEFAULT_SPEC_KEYWORDS),
        report_support_keywords=pick("reportSupportKeywords", _keywords, DEFAULT_REPORT_SUPPORT_KEYWORDS),
        review_columns=pick("reviewColumns", _review_columns, dict(REVIEW_COLUMNS)),
        contents_headers=pick("contentsHeaders", _contents_headers, DEFAULT_CONTENTS_HEADERS),
        contents_sheet_name=pick("contentsSheetName", _contents_sheet_name, DEFAULT_CONTENTS_SHEET_NAME),
        status_column_name=pick("statusColumnName", lambda value: _plain_text(value, 128), DEFAULT_STATUS_COLUMN),
        warnings=(PROFILE_INVALID_WARNING,) if invalid else (),
    )


def load_project_profile(project_path: Path | str | None = None) -> ProjectProfile:
    override = os.environ.get(PROFILE_ENV_VAR, "").strip()
    if override:
        path = Path(override)
    elif project_path is not None:
        path = Path(project_path) / PROFILE_RELATIVE_PATH
    else:
        return ProjectProfile()
    if not path.is_file():
        return ProjectProfile()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ProjectProfile(warnings=(PROFILE_INVALID_WARNING,))
    if not isinstance(raw, dict):
        return ProjectProfile(warnings=(PROFILE_INVALID_WARNING,))
    return _from_mapping(raw)
