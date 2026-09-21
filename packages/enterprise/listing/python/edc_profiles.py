"""学习型 EDC 适配器注册表（2026-09-07）。

三层设计表识别的第三层：
1. discovery._DESIGN_SHEET_SIGNATURES —— 已知 EDC 的手写适配器（Rave/太美/ODM-DED）；
2. design_inference —— 名字无关的结构推断，兜底任何新 EDC，但需要数据集已加载；
3. 本模块 —— 推断一旦在某个工作簿里识别出设计 sheet，就把该 sheet 的**表头形态**
   与**列角色**持久化；此后同一 EDC 的任何项目（表头集合相同或是其超集）在
   discovery 层直接按适配器命中，不再依赖数据集在场，且能抽取映射。

只保存结构：sheet 名、表头列名、角色→表头名、学习次数/时间。不保存任何单元格
值、项目名、文件路径——表头是车道本就披露的结构（read_metadata 的 headerRows）。
注册表文件由宿主经 DSH_EDC_PROFILES 指定（默认 profiles/enterprise/.edc-profiles.json，
与数据安全开关配置同目录）；缺省回落用户目录。读写失败只降级为"本次不学习"，
不影响红线（红线由保护值索引保证，与是否学到适配器无关）。
"""
import datetime
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any, Optional

MIN_NAMED_HEADERS = 2
ROLE_NAMES = ("dataset", "variable", "label")


def profiles_path() -> Path:
    configured = os.environ.get("DSH_EDC_PROFILES")
    if configured:
        return Path(configured)
    return Path.home() / ".dsh-enterprise" / "edc-profiles.json"


def _named_headers(headers: list[str]) -> list[str]:
    return [header.strip() for header in headers
            if header and header.strip() and not header.strip().startswith("Unnamed")]


def _profile_id(headers: list[str]) -> str:
    digest = hashlib.sha1("\x00".join(sorted(headers)).encode("utf-8")).hexdigest()
    return f"learned-{digest[:12]}"


def load_profiles(path: Optional[Path] = None) -> list[dict[str, Any]]:
    target = path or profiles_path()
    try:
        loaded = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if not isinstance(loaded, list):
        return []
    profiles: list[dict[str, Any]] = []
    for item in loaded:
        if not isinstance(item, dict):
            continue
        headers = item.get("headers")
        if not isinstance(headers, list) or len(_named_headers([str(h) for h in headers])) < MIN_NAMED_HEADERS:
            continue
        roles = item.get("roles") if isinstance(item.get("roles"), dict) else {}
        profiles.append({
            "id": str(item.get("id") or _profile_id([str(h) for h in headers])),
            "sheetName": str(item.get("sheetName", "")),
            "headers": [str(h) for h in headers],
            "roles": {role: str(header) for role, header in roles.items()
                      if role in ROLE_NAMES and isinstance(header, str) and header},
            "seen": int(item.get("seen", 1) or 1),
            "learnedAt": str(item.get("learnedAt", "")),
            "lastSeen": str(item.get("lastSeen", "")),
        })
    return profiles


def _save_profiles(profiles: list[dict[str, Any]], target: Path) -> bool:
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(target.suffix + ".tmp")
        temporary.write_text(json.dumps(profiles, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, target)
        return True
    except OSError as exc:
        sys.stderr.write(f"[enterprise-listing] edc profile write failed: {exc}\n")
        return False


def match_profile(headers: list[str], profiles: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """表头集合包含某个已学习 profile 的全部表头即命中（列增加/重排不影响）。"""
    header_set = {header.strip() for header in headers}
    for profile in profiles:
        if set(_named_headers(profile["headers"])) <= header_set:
            return profile
    return None


def learn_profile(
    sheet_name: str, headers: list[str], roles: dict[str, str], path: Optional[Path] = None,
) -> Optional[dict[str, Any]]:
    """登记一个设计 sheet 的表头形态；已存在则累计次数。返回登记后的 profile。"""
    named = _named_headers(headers)
    if len(named) < MIN_NAMED_HEADERS:
        return None
    target = path or profiles_path()
    profiles = load_profiles(target)
    now = datetime.datetime.now().isoformat(timespec="seconds")
    profile_id = _profile_id(named)
    existing = next((item for item in profiles if item["id"] == profile_id), None)
    if existing is not None:
        existing["seen"] += 1
        existing["lastSeen"] = now
        for role, header in roles.items():
            if role in ROLE_NAMES and header in named and role not in existing["roles"]:
                existing["roles"][role] = header
        return existing if _save_profiles(profiles, target) else None
    profile = {
        "id": profile_id,
        "sheetName": str(sheet_name),
        "headers": named,
        "roles": {role: header for role, header in roles.items() if role in ROLE_NAMES and header in named},
        "seen": 1,
        "learnedAt": now,
        "lastSeen": now,
    }
    profiles.append(profile)
    return profile if _save_profiles(profiles, target) else None