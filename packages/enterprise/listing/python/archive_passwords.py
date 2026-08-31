"""ZIP 密码解析与安全解压。"""
import os
import re
import shutil
import zipfile
import zlib
from pathlib import Path
from typing import Iterable, Optional

#: 归档密码注入环境变量（宿主/现场兜底：密码推导候选全覆盖不到时
#: 的逃生通道；优先级在显式凭据之后、推导候选之前）。
ARCHIVE_PASSWORD_ENV = "DSH_ARCHIVE_PASSWORD"

#: 密码类失败信号：候选循环遇到即视为"该密码不对，继续下一个候选"。
#: - RuntimeError：ZipCrypto 校验字节不匹配（zipfile 的 Bad password）；
#: - zlib.error / BadZipFile：错误密码有 1/256 概率碰巧通过 1 字节校验头
#:   （BUG-R2：真实 zip 25 候选中即出现 1 例），随后数据解压报错——
#:   旧实现未捕获直接冒泡，正确候选（排在其后）永远没机会被尝试；
#:   BadZipFile 同时覆盖 CRC 不匹配（"密码可能对但数据损坏"——同样
#:   继续尝试余下候选，全败后统一抛凭据未解析信号）；
#: - EOFError：截断流。
_PASSWORD_FAILURES = (RuntimeError, zipfile.BadZipFile, zlib.error, EOFError)

#: 旧式归档（未置 UTF-8 旗标 0x800）条目名的 OEM 码页。中文 Windows
#: 打包工具实际写 GBK，zipfile 一律按 cp437 解码 → 条目名乱码。
#: 兜底：cp437 重编码后按 GBK 解回；ASCII 名恒等不受影响，GBK 解码
#: 失败保留原名（可能真是 cp437 文本）。
_LEGACY_NAME_CODECS = ("cp437", "gbk")


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
    env_password = os.environ.get(ARCHIVE_PASSWORD_ENV)
    if env_password:
        add(env_password)
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


def _fix_legacy_filename(info: zipfile.ZipInfo) -> None:
    """旧式条目名编码兜底：cp437 解码名尝试重编码后按 GBK 解回。

    就地改写 ``info.filename``（``extract`` 以该字段落盘）；仅当重解码
    成功且与原名不同时替换，UTF-8 旗标（0x800）成员与 ASCII 名不受影响。
    """
    if info.flag_bits & 0x800:
        return
    name = info.filename
    try:
        fixed = name.encode(_LEGACY_NAME_CODECS[0]).decode(_LEGACY_NAME_CODECS[1])
    except (UnicodeEncodeError, UnicodeDecodeError):
        return
    if fixed != name:
        info.filename = fixed


def _safe_members(zf: zipfile.ZipFile, extract_to: Path) -> list[zipfile.ZipInfo]:
    root = extract_to.resolve()
    members = []
    for info in zf.infolist():
        _fix_legacy_filename(info)          # 先修名（GBK 兜底），再以修后名做越界校验
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
        except _PASSWORD_FAILURES as exc:
            last_error = exc
            continue
    raise RuntimeError(f"Archive credential was not resolved for {archive_path.name}") from last_error
