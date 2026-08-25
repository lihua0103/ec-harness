"""临床 Listing 插件的权威本地路径与归档边界。"""
from __future__ import annotations

import os
import shutil
import stat
import tempfile
import zipfile
from pathlib import Path, PurePosixPath, PureWindowsPath


class PathPolicyError(ValueError):
    """不包含宿主路径或数据值的安全拒绝原因。"""


def system_temp_root() -> Path:
    """系统统一临时目录：只落在当前系统目录（<系统根>/.cache/tmp）。

    2026-08-24：系统不往 C 盘写任何数据。Python ``tempfile`` 默认跟随
    TEMP/TMP（C:\\Users\\...\\AppData\\Local\\Temp），SAS 解压、staging、
    测试临时文件此前都会落到 C 盘。所有临时文件统一经此入口取根：
    EMERALD_TMP_ROOT 环境变量优先（部署可覆写），否则取系统目录下的
    .cache/tmp。
    """
    override = os.environ.get("EMERALD_TMP_ROOT", "").strip()
    root = Path(override) if override else Path(__file__).resolve().parents[2] / ".cache" / "tmp"
    root.mkdir(parents=True, exist_ok=True)
    return root


MAX_ARCHIVE_FILES = 10_000
MAX_ARCHIVE_FILE_BYTES = 10 * 1024 * 1024 * 1024  # 10GB (真实临床数据规模)
MAX_ARCHIVE_TOTAL_BYTES = 20 * 1024 * 1024 * 1024  # 20GB
# SAS7BDAT/XPT 中的大块空白页压缩比很高，真实项目可稳定超过 250:1。
# 仍与成员数、单文件 10GB、总量 20GB 三道硬边界共同限制解压成本。
MAX_ARCHIVE_RATIO = 1_000


def resolve_under_root(
    root: str | Path,
    requested: str | Path,
    *,
    must_exist: bool = True,
    allow_root: bool = True,
) -> Path:
    """解析根内路径；拒绝绝对请求、父目录跳转和符号链接逃逸。"""
    if not str(root).strip():
        raise PathPolicyError("local data root is not configured")
    if not str(requested).strip():
        raise PathPolicyError("relative path is required")
    try:
        base = Path(root).resolve(strict=True)
    except OSError as exc:
        raise PathPolicyError("configured root is unavailable") from exc
    relative_request = Path(requested)
    if relative_request.is_absolute() or PureWindowsPath(str(requested)).is_absolute():
        raise PathPolicyError("absolute paths are not accepted")
    try:
        candidate = (base / relative_request).resolve(strict=must_exist)
    except OSError as exc:
        raise PathPolicyError("requested path is unavailable") from exc
    try:
        relative = candidate.relative_to(base)
    except ValueError as exc:
        raise PathPolicyError("requested path is outside the configured root") from exc
    if not allow_root and relative == Path('.'):
        raise PathPolicyError("the configured root itself is not an accepted target")
    return candidate


def relative_display_path(root: str | Path, target: str | Path) -> str:
    base = Path(root).resolve(strict=True)
    candidate = Path(target).resolve(strict=False)
    try:
        relative = candidate.relative_to(base)
    except ValueError as exc:
        raise PathPolicyError("path cannot be represented inside the configured root") from exc
    return relative.as_posix() or "."


def resolve_credential(credentials_dir: str | Path, credential_ref: str) -> Path:
    path = resolve_under_root(credentials_dir, credential_ref, allow_root=False)
    if not path.is_file():
        raise PathPolicyError("credential reference is not a regular file")
    return path


def read_credential(credentials_dir: str | Path, credential_ref: str) -> bytes:
    path = resolve_credential(credentials_dir, credential_ref)
    try:
        value = path.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeError) as exc:
        raise PathPolicyError("credential reference cannot be read") from exc
    # 临床交付包常用空文件名作为本地凭据提示；非空内容原样留在本地内存，
    # 不把多行或长度当作与数据安全有关的硬拒条件。
    if not value:
        return path.stem.encode("utf-8")
    return value.encode("utf-8")


def _validated_member(info: zipfile.ZipInfo) -> PurePosixPath:
    normalized = info.filename.replace("\\", "/")
    member = PurePosixPath(normalized)
    windows_member = PureWindowsPath(info.filename)
    if not normalized or member.is_absolute() or windows_member.is_absolute():
        raise PathPolicyError("archive contains an absolute member path")
    if any(part in ("", ".", "..") for part in member.parts):
        raise PathPolicyError("archive contains an unsafe member path")
    mode = info.external_attr >> 16
    if stat.S_ISLNK(mode):
        raise PathPolicyError("archive symbolic links are not accepted")
    if info.file_size > MAX_ARCHIVE_FILE_BYTES:
        raise PathPolicyError("archive member exceeds the size limit")
    if info.compress_size == 0 and info.file_size > 0:
        raise PathPolicyError("archive member has an unsafe compression ratio")
    if info.compress_size and info.file_size / info.compress_size > MAX_ARCHIVE_RATIO:
        raise PathPolicyError("archive member has an unsafe compression ratio")
    return member


def safe_extract_zip(
    zip_path: Path, destination: Path, password: bytes | None = None,
    include_datasets: set[str] | None = None,
) -> list[Path]:
    """带数量、大小、压缩比、路径和链接限制地解压 ZIP。

    include_datasets 指定时，仅提取对应 stem 的临床源数据成员；仍校验全部
    ZIP 目录，以保留路径、链接、数量和压缩比安全边界。"""
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and any(destination.iterdir()):
        raise PathPolicyError("managed extraction directory is not empty")
    temporary = Path(tempfile.mkdtemp(prefix=".extract-", dir=destination.parent))
    base = temporary.resolve(strict=True)
    extracted: list[Path] = []
    total_size = 0
    try:
        try:
            import pyzipper
            archive_type = pyzipper.AESZipFile
        except ImportError:
            archive_type = zipfile.ZipFile
        with archive_type(zip_path, "r") as archive:
            infos = archive.infolist()
            if len(infos) > MAX_ARCHIVE_FILES:
                raise PathPolicyError("archive contains too many members")
            members: list[tuple[zipfile.ZipInfo, PurePosixPath]] = []
            for info in infos:
                member = _validated_member(info)
                total_size += info.file_size
                if total_size > MAX_ARCHIVE_TOTAL_BYTES:
                    raise PathPolicyError("archive exceeds the total size limit")
                members.append((info, member))
            selected = {name.casefold() for name in include_datasets or set()}
            for info, member in members:
                if selected and not info.is_dir() and Path(info.filename).suffix.casefold() in {".sas7bdat", ".xpt", ".csv"} and Path(info.filename).stem.casefold() not in selected:
                    continue
                target = (base / Path(*member.parts)).resolve(strict=False)
                try:
                    target.relative_to(base)
                except ValueError as exc:
                    raise PathPolicyError("archive member escapes the destination") from exc
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info, "r", pwd=password) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
                extracted.append(target)
        if destination.exists():
            destination.rmdir()
        temporary.replace(destination)
        return [destination / path.relative_to(base) for path in extracted]
    except PathPolicyError:
        raise
    except (OSError, RuntimeError, zipfile.BadZipFile) as exc:
        raise PathPolicyError("archive extraction failed") from exc
    finally:
        if temporary.exists():
            try:
                shutil.rmtree(temporary)
            except PermissionError:
                # Windows 通过 WSL 访问时的权限映射问题
                # 尝试修改权限后再删除
                import os
                for root, dirs, files in os.walk(str(temporary), topdown=False):
                    for name in files:
                        try:
                            file_path = os.path.join(root, name)
                            os.chmod(file_path, stat.S_IWRITE | stat.S_IREAD)
                            os.unlink(file_path)
                        except Exception:
                            pass  # 单个文件失败不中断
                    for name in dirs:
                        try:
                            os.rmdir(os.path.join(root, name))
                        except Exception:
                            pass
                try:
                    os.rmdir(str(temporary))
                except Exception:
                    # 最后仍然失败则记录但不抛出异常
                    pass
