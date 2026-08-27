"""ZIP 密码解析与安全解压。"""
import re
import shutil
import zipfile
from pathlib import Path
from typing import Iterable, Optional


def _candidate_tokens(value: str) -> Iterable[str]:
    yield value
    stem = Path(value).stem
    if stem != value:
        yield stem
    yield from (part for part in re.split(r"[_/\-.\s]+", stem) if len(part) >= 2)
    yield from re.findall(r"\d{2,}", stem)


def password_candidates(project: Path, archive: Path, explicit: Optional[str] = None) -> list[Optional[bytes]]:
    candidates: list[Optional[bytes]] = []
    seen: set[bytes] = set()
    def add(value: Optional[str]) -> None:
        if value is None:
            if None not in candidates:
                candidates.append(None)
            return
        for token in _candidate_tokens(value):
            encoded = token.encode("utf-8")
            if encoded not in seen:
                seen.add(encoded); candidates.append(encoded)
    if explicit:
        add(explicit)
    add(project.name)
    for sidecar in archive.parent.glob("*.txt"):
        try:
            content = sidecar.read_text(encoding="utf-8").strip()
            if content:
                add(content)
        except OSError:
            continue
    add(archive.name)
    for path in project.rglob("*"):
        if path.is_file() and path.suffix.lower() in {".txt", ".xlsx", ".xls"}:
            add(path.stem)
    add(None)
    return candidates


def _safe_members(zf: zipfile.ZipFile, extract_to: Path) -> list[zipfile.ZipInfo]:
    root = extract_to.resolve()
    members = []
    for info in zf.infolist():
        target = (root / info.filename).resolve()
        try:
            target.relative_to(root)
        except ValueError as exc:
            raise ValueError(f"ZIP成员越界: {info.filename}") from exc
        members.append(info)
    return members


def extract_with_password(archive_path: Path, extract_to: Path, project: Path,
                          explicit_password: Optional[str] = None) -> None:
    last_error: Exception | None = None
    for password in password_candidates(project, archive_path, explicit_password):
        try:
            with zipfile.ZipFile(archive_path, "r") as zf:
                members = _safe_members(zf, extract_to)
                # 每次候选前清空，避免失败密码留下部分文件。
                shutil.rmtree(extract_to, ignore_errors=True)
                extract_to.mkdir(parents=True, exist_ok=True)
                for member in members:
                    zf.extract(member, path=extract_to, pwd=password)
                return
        except RuntimeError as exc:
            last_error = exc
            continue
    raise RuntimeError(f"Archive credential was not resolved for {archive_path.name}") from last_error
