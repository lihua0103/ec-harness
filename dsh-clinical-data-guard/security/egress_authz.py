"""L3 数据决策的本地会话授权记录。

授权只保存固定类别、单向哈希身份和工程时间戳，不保存临床数据值。默认无授权，
读取失败也返回空集合，安全侧始终回退为拦截/脱敏。

FIX-4 (FR-13): L3_ALLOW_AUDITED 仅当次有效——检查侧通过 consume_category 消费，
消费即从记录中移除，同一授权不会被二次使用。
FIX-9 (R-6): 身份哈希与审计记录使用同一 stable_hash 上下文，二者可关联。
FIX-12 (FR-16-07): 授权 root 可经 EMERALD_AUTHZ_ROOT 配置。
"""
from __future__ import annotations

import json
import os
import tempfile
import time
from typing import Optional, Set

from security.audit_log import _exclusive_lock
from security.patterns import stable_hash

_AUTHORIZABLE_CATEGORIES = frozenset({
    "L3_SKIP",
    "L3_REDACTED_CONTINUE",
    "L3_ALLOW_AUDITED",
})


def is_authorizable(category: str) -> bool:
    return category in _AUTHORIZABLE_CATEGORIES


def _has_identity(user: Optional[str], session: Optional[str]) -> bool:
    """ST-P1-4: 授权必须绑定明确的 user+session 身份。任一缺失即拒绝授权/消费
    （fail-closed），杜绝 None/空串全部坍缩到共享 'anonymous' 桶后跨会话共享授权。"""
    return bool(user) and str(user).strip() != "" and bool(session) and str(session).strip() != ""


def _default_root() -> str:
    # ST-P2-13: 默认目录改回项目内 var/，符合规范 §10.2（禁止落用户主目录）。
    # 仍可通过 EMERALD_AUTHZ_ROOT 覆盖至其他路径。
    _pkg_root = os.path.normpath(os.path.join(os.path.dirname(__file__), '..'))
    return os.environ.get("EMERALD_AUTHZ_ROOT") or os.path.join(
        _pkg_root, "var", "egress_authz"
    )


def _session_key(value: Optional[str]) -> str:
    return stable_hash(value)


def _authz_path(root: str, user: Optional[str], session: Optional[str]) -> str:
    base = root or _default_root()
    return os.path.join(base, _session_key(user), _session_key(session), "egress_authz.json")


def _read_categories(path: str) -> Set[str]:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        categories = data.get("categories", []) if isinstance(data, dict) else []
        return {item for item in categories if item in _AUTHORIZABLE_CATEGORIES}
    except (OSError, ValueError, TypeError):
        return set()


def authorized_categories(root: str, user: Optional[str],
                          session: Optional[str]) -> Set[str]:
    path = _authz_path(root, user, session)
    return _read_categories(path)


def _write_record(path: str, record: dict) -> None:
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix=".egress_authz-", dir=os.path.dirname(path), text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(record, handle, ensure_ascii=False, separators=(",", ":"))
            handle.write("\n")
        os.chmod(temp_path, 0o600)
        os.replace(temp_path, path)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)


def authorize_category(root: str, user: Optional[str], session: Optional[str],
                       category: str, operator: Optional[str] = None) -> dict:
    if not is_authorizable(category):
        return {"ok": False, "error": "category_not_authorizable"}
    # ST-P1-4: 缺身份不授权，避免跨会话共享 anonymous 桶。
    if not _has_identity(user, session):
        return {"ok": False, "error": "identity_required"}

    path = _authz_path(root, user, session)
    directory = os.path.dirname(path)
    os.makedirs(directory, mode=0o700, exist_ok=True)

    # ST-P1-3 (TOCTOU): 读-改-写全程持目录级排他锁，杜绝并发下授权记录互相覆盖。
    with _exclusive_lock(directory):
        existing = {"categories": [], "audit": []}
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as handle:
                    loaded = json.load(handle)
                if isinstance(loaded, dict):
                    existing = loaded
            except (OSError, ValueError):
                pass

        categories = {item for item in existing.get("categories", []) if item in _AUTHORIZABLE_CATEGORIES}
        categories.add(category)
        audit = existing.get("audit", []) if isinstance(existing.get("audit", []), list) else []
        audit.append({
            "category": category,
            "operator": "sha256:" + _session_key(operator),
            "timestamp": int(time.time()),
        })
        record = {"categories": sorted(categories), "audit": audit}
        _write_record(path, record)
    return {"ok": True, "categories": sorted(categories)}


def consume_category(root: str, user: Optional[str], session: Optional[str],
                     category: str = "L3_ALLOW_AUDITED") -> bool:
    """FIX-4 (FR-13): 检查侧一次性消费授权。

    授权存在则移除并返回 True（当次放行），不存在或读取失败返回 False。
    L3_ALLOW_AUDITED 永不持久生效：消费即删除。
    ST-P1-3 (TOCTOU): 读-改-写全程持锁，杜绝并发双消费同一授权。
    ST-P1-4: 缺身份直接拒绝消费。
    """
    if not is_authorizable(category):
        return False
    if not _has_identity(user, session):
        return False
    path = _authz_path(root, user, session)
    directory = os.path.dirname(path)
    if not os.path.isdir(directory):
        return False
    with _exclusive_lock(directory):
        categories = _read_categories(path)
        if category not in categories:
            return False
        categories.discard(category)
        record = {"categories": sorted(categories), "audit": []}
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as handle:
                    loaded = json.load(handle)
                if isinstance(loaded, dict) and isinstance(loaded.get("audit", []), list):
                    record["audit"] = loaded["audit"]
            except (OSError, ValueError):
                pass
        _write_record(path, record)
    return True
