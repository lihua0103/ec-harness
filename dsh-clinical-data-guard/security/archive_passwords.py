"""可信本地 Listing 执行器的 ZIP 密码候选生成与受控解压。"""
from __future__ import annotations

import re
import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Iterable

from security.path_policy import PathPolicyError, safe_extract_zip

MAX_NESTED_ARCHIVE_DEPTH = 3


def _candidate_tokens(value: str) -> Iterable[str]:
    yield value
    stem = Path(value).stem
    if stem != value:
        yield stem
    yield from (part for part in re.split(r"[_/\-.\s]+", stem) if len(part) >= 2)
    yield from re.findall(r"\d{2,}", stem)


def password_candidates(
    project: Path,
    archive: Path,
    explicit: bytes | str | None = None,
    include_datasets: set[str] | None = None,
) -> list[bytes | None]:
    """按 Emerald 规则生成候选；候选只存在于本地内存，不进入收据。"""
    values: list[bytes | None] = []
    seen: set[bytes | None] = set()

    def add(value: bytes | str | None) -> None:
        if isinstance(value, str):
            value = value.strip().encode("utf-8")
        if value == b"":
            value = None
        if value not in seen:
            seen.add(value)
            values.append(value)

    if explicit is not None:
        add(explicit)
    for project_id in (project.name,):
        add(project_id)
        add(re.sub(r"[^A-Za-z0-9]", "", project_id))
        prefix = project_id
        while "-" in prefix:
            prefix = prefix.rsplit("-", 1)[0]
            add(prefix)

    for sidecar in sorted(project.rglob("*.txt"), key=lambda path: path.as_posix().lower()):
        try:
            if not sidecar.is_file():
                continue
            add(sidecar.stem)
            text = sidecar.read_text(encoding="utf-8").strip()
            if text:
                add(text)
        except (OSError, UnicodeError):
            continue

    for value in _candidate_tokens(archive.name):
        add(value)
    for path in sorted(project.rglob("*"), key=lambda item: item.as_posix().lower()):
        if path.is_file() and path != archive and path.suffix.lower() != ".txt":
            for value in _candidate_tokens(path.name):
                add(value)
    add(None)
    return values


def extract_dataset_archive(
    project: Path,
    archive: Path,
    destination: Path,
    explicit: bytes | str | None = None,
    include_datasets: set[str] | None = None,
    _depth: int = 0,
) -> list[Path]:
    """在本地临时目录试解 ZIP，完整成功后才发布受管解压目录。"""
    if _depth > MAX_NESTED_ARCHIVE_DEPTH:
        raise PathPolicyError("archive nesting exceeds the supported depth")
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(archive, "r") as bundle:
            encrypted = any(info.flag_bits & 0x1 for info in bundle.infolist())
    except (OSError, zipfile.BadZipFile) as exc:
        raise PathPolicyError("archive extraction failed") from exc

    candidates = password_candidates(project, archive, explicit) if encrypted else [None]
    for candidate in candidates:
        attempt_root = Path(tempfile.mkdtemp(prefix=".listing-zip-", dir=destination.parent))
        attempt = attempt_root / "content"
        try:
            extracted = safe_extract_zip(
                archive, attempt, candidate, include_datasets=include_datasets,
            )
            if destination.exists():
                shutil.rmtree(destination)
            attempt.replace(destination)
            published = [destination / path.relative_to(attempt) for path in extracted]
            nested_outputs: list[Path] = []
            for nested_index, nested in enumerate(
                path for path in published if path.suffix.casefold() == ".zip"
            ):
                nested_destination = destination / f".nested-{nested_index:04d}"
                nested_outputs.extend(extract_dataset_archive(
                    project,
                    nested,
                    nested_destination,
                    explicit,
                    include_datasets,
                    _depth + 1,
                ))
            return published + nested_outputs
        except PathPolicyError as exc:
            # zipfile 用 RuntimeError 表示加密成员的密码错误。路径穿越、链接、
            # 文件数量/大小/压缩比等结构违规由 safe_extract_zip 直接抛出，
            # 必须立即 fail closed，不能被后续候选掩盖成普通密码失败。
            if isinstance(exc.__cause__, RuntimeError):
                continue
            raise
        finally:
            if attempt_root.exists():
                shutil.rmtree(attempt_root)
    sidecar_count = sum(1 for path in project.rglob("*.txt") if path.is_file())
    source_kinds = ["project identifier", "archive name", "local file names"]
    if explicit is not None:
        source_kinds.insert(0, "credentialRef")
    if sidecar_count:
        source_kinds.append(f"sidecar files ({sidecar_count})")
    raise PathPolicyError(
        "archive credential was not resolved; tried local sources: "
        + ", ".join(source_kinds)
        + "; provide or correct credentialRef in the configured credentials directory"
    )
