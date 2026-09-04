"""ZIP 密码解析与安全解压。"""
import re
import shutil
import zipfile
from dataclasses import dataclass
import zlib
from pathlib import Path
from typing import Iterable, Optional

try:
    import pyzipper
except ImportError:  # 允许非 AES 项目继续使用标准 zipfile。
    pyzipper = None


class ArchivePasswordRequired(RuntimeError):
    """归档成员加密且当前凭据引用未能解锁。"""


class InvalidArchive(RuntimeError):
    """输入不是有效 ZIP 归档。"""


_AES_COMPRESSION_METHOD = 99

#: 解压预算（zip bomb 防护）：归档是赞助商提供的外部输入，10MB 压缩包
#: 声明 PB 级解压输出会在超时窗口内撑爆磁盘并杀死持久 worker。
#: 实测校准：真实 RBQM 项目归档解压后 10.2GB（72 个数据集），预算取
#: 64GB 只拦数量级异常；更精细的爆炸特征由单成员压缩比检查承担。
MAX_ARCHIVE_UNCOMPRESSED_BYTES = 64 * 1024 ** 3
#: 单成员压缩比上限；只对大于 1MB 的成员生效（小成员高压缩比是常态）。
MAX_ARCHIVE_COMPRESSION_RATIO = 500
_RATIO_FLOOR_BYTES = 1024 * 1024


def _check_archive_budget(infos: list) -> None:
    total = sum(info.file_size for info in infos)
    if total > MAX_ARCHIVE_UNCOMPRESSED_BYTES:
        raise InvalidArchive(
            f"Archive uncompressed total {total} exceeds budget {MAX_ARCHIVE_UNCOMPRESSED_BYTES}")
    for info in infos:
        if (info.file_size > _RATIO_FLOOR_BYTES and info.compress_size > 0
                and info.file_size / info.compress_size > MAX_ARCHIVE_COMPRESSION_RATIO):
            raise InvalidArchive(
                f"Archive member compression ratio exceeds limit: {info.filename}")


@dataclass(frozen=True)
class ArchiveExtractionResult:
    """一次解压的结果；密码受限成员由调用方显式记录，不允许静默丢失。"""

    extracted_count: int
    password_required_count: int

    @property
    def has_password_required(self) -> bool:
        return self.password_required_count > 0

    @property
    def partial(self) -> bool:
        return self.extracted_count > 0 and self.has_password_required


def _candidate_tokens(value: str) -> Iterable[str]:
    yield value
    stem = Path(value).stem
    if stem != value:
        yield stem
    yield from (part for part in re.split(r"[_/\-.\s]+", stem) if len(part) >= 2)
    yield from re.findall(r"\d{2,}", stem)


def _contiguous_token_passwords(value: str) -> Iterable[str]:
    """由项目/归档名片段生成少量受控组合，不进行无边界枚举。"""
    stem = Path(value).stem
    tokens = [part for part in re.split(r"[_/\-.\s]+", stem) if part]
    if len(tokens) < 2:
        return
    seen: set[str] = set()
    for start in range(len(tokens)):
        for end in range(start + 2, len(tokens) + 1):
            for separator in ("", "_", "-"):
                candidate = separator.join(tokens[start:end])
                if len(candidate) >= 2 and candidate not in seen:
                    seen.add(candidate)
                    yield candidate


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
    for candidate in _contiguous_token_passwords(project.name):
        add(candidate)
    for sidecar in archive.parent.glob("*.txt"):
        try:
            content = sidecar.read_text(encoding="utf-8").strip()
            if content:
                add(content)
        except OSError:
            continue
    add(archive.name)
    for candidate in _contiguous_token_passwords(archive.name):
        add(candidate)
    for path in project.rglob("*"):
        if path.is_file() and path.suffix.lower() in {".txt", ".xlsx", ".xls"}:
            add(path.stem)
    add(None)
    return candidates


def _safe_members(zf, extract_to: Path) -> list:
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
                          explicit_password: Optional[str] = None) -> ArchiveExtractionResult:
    last_error: Exception | None = None
    try:
        with zipfile.ZipFile(archive_path, "r") as probe:
            _check_archive_budget(probe.infolist())
    except zipfile.BadZipFile as exc:
        raise InvalidArchive("Archive is not a valid zip") from exc
    archive_class = pyzipper.AESZipFile if pyzipper is not None else zipfile.ZipFile
    for password in password_candidates(project, archive_path, explicit_password):
        extracted_count = 0
        password_required_count = 0
        # 每次候选前清空，避免失败密码留下部分文件。
        shutil.rmtree(extract_to, ignore_errors=True)
        extract_to.mkdir(parents=True, exist_ok=True)
        with archive_class(archive_path, "r") as zf:
            uses_aes = any(
                info.compress_type == _AES_COMPRESSION_METHOD
                for info in zf.infolist()
            )
            if uses_aes and pyzipper is None:
                raise ArchivePasswordRequired("AES ZIP support is unavailable")
            members = _safe_members(zf, extract_to)
            for member in members:
                if member.is_dir():
                    continue
                try:
                    zf.extract(member, path=extract_to, pwd=password)
                    extracted_count += 1
                except zipfile.BadZipFile as exc:
                    raise InvalidArchive(
                        f"Archive member is not a valid zip entry: {member.filename}"
                    ) from exc
                except zlib.error as exc:
                    if not member.flag_bits & 1:
                        raise InvalidArchive(
                            f"Archive member is corrupt: {member.filename}"
                        ) from exc
                    # ZipCrypto 的 8 位口令校验可能误通过；解压失败仍属密码未命中。
                    password_required_count += 1
                    last_error = exc
                except RuntimeError as exc:
                    if not member.flag_bits & 1:
                        raise
                    password_required_count += 1
                    last_error = exc
        if password_required_count == 0:
            return ArchiveExtractionResult(extracted_count, 0)
    if extracted_count > 0:
        # 混合归档：先给调用方可用成员；缺失加密成员必须作为缺陷回执。
        return ArchiveExtractionResult(extracted_count, password_required_count)
    if isinstance(last_error, zipfile.BadZipFile):
        raise InvalidArchive(f"Archive is not a valid zip: {archive_path.name}") from last_error
    raise ArchivePasswordRequired("Archive credential was not resolved") from last_error
