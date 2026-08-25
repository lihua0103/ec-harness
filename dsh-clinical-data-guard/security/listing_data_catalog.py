"""临床 Listing 的受控本地数据目录。

项目目录是只读数据域。运行时解压目录固定在项目内 _work 子目录（项目数据归属原则）；
inspect 只索引归档目录与明文数据集，execute 才按 ListingPlan 引用的数据集最小化解压。
"""
from __future__ import annotations

import hashlib
import shutil
import tempfile
import time
import zipfile
from pathlib import Path

from security.archive_passwords import extract_dataset_archive
from security.path_policy import PathPolicyError

SOURCE_SUFFIXES = {".sas7bdat", ".xpt", ".csv"}
IGNORED_DIRECTORIES = {".clinical-listing", "_work", "__pycache__"}

WORK_DIR_NAME = "_work"
WORK_SESSION_PREFIX = "listing-"
STALE_WORK_AGE_SECONDS = 6 * 60 * 60


def _file_digest(path: Path) -> bytes:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.digest()


def _sweep_stale_work_dirs(work_root: Path) -> None:
    """回收历史运行遗留的解压工作区。

    2026-08-24：解压目录固化进项目内后，close() 只清理正常路径；超时被杀、
    进程崩溃或宿主重启留下的 ``_work/listing-*`` 会积在项目树里（单个 RBQM
    归档解压近百 MB）。仅删早于 STALE_WORK_AGE_SECONDS 的目录，避免误删并发
    会话正在使用的工作区；删除失败（Windows 文件锁）静默跳过，留待下次清扫。
    """
    if not work_root.is_dir():
        return
    cutoff = time.time() - STALE_WORK_AGE_SECONDS
    for stale in work_root.glob(f"{WORK_SESSION_PREFIX}*"):
        if not stale.is_dir():
            continue
        try:
            if stale.stat().st_mtime >= cutoff:
                continue
        except OSError:
            continue
        shutil.rmtree(stale, ignore_errors=True)


class DatasetCatalog:
    def __init__(
        self,
        project: Path,
        credential: bytes | str | None = None,
        required_datasets: set[str] | None = None,
        materialize_archives: bool = True,
    ) -> None:
        self.project = project.resolve(strict=True)
        self.credential = credential
        self.required_datasets = {
            name.casefold() for name in (required_datasets or set())
        }
        self.materialize_archives = materialize_archives
        self._work: Path | None = None
        self._files: dict[str, list[Path]] = {}
        self._archive_datasets: dict[str, list[str]] = {}
        self.missing_archives: list[str] = []

    def __enter__(self) -> "DatasetCatalog":
        # 2026-08-24 P0 修复：解压工作区固化在项目内 _work 子目录（项目数据归属原则）。
        # IGNORED_DIRECTORIES 已含 _work，_project_files 遍历不会重复索引解压产物。
        # 项目内位置保证数据归属可追溯，且解压路径天然在项目目录白名单内，无需额外
        # 并入 allowed_data_dirs，方案更简洁。
        work_root = self.project / WORK_DIR_NAME
        work_root.mkdir(parents=True, exist_ok=True)
        _sweep_stale_work_dirs(work_root)
        self._work = Path(tempfile.mkdtemp(prefix=WORK_SESSION_PREFIX, dir=work_root))
        try:
            self._scan_project_files()
            archives = self._index_archives()
            if self.materialize_archives:
                self._materialize_archives(archives)
            return self
        except Exception:
            self.close()
            raise

    def __exit__(self, _type, _value, _traceback) -> None:
        self.close()

    def close(self) -> None:
        if self._work is not None:
            shutil.rmtree(self._work, ignore_errors=True)
        self._work = None

    @property
    def work_dir(self) -> Path | None:
        """当前解压工作区（项目内 _work 子目录，随 close() 删除）；未打开时为 None。

        2026-08-24 P0 修复：固化在项目内后，解压路径天然落在项目目录白名单内，
        调用方无需额外并入 allowed_data_dirs。
        """
        return self._work

    def _project_files(self):
        """只遍历原始项目输入，忽略历史运行目录及其权限状态。"""
        stack = [self.project]
        while stack:
            directory = stack.pop()
            try:
                entries = list(directory.iterdir())
            except OSError:
                continue
            for entry in entries:
                try:
                    if entry.is_dir():
                        if entry.name.casefold() not in IGNORED_DIRECTORIES:
                            stack.append(entry)
                    elif entry.is_file():
                        yield entry
                except OSError:
                    continue

    def _record(self, path: Path) -> None:
        self._files.setdefault(path.stem.casefold(), []).append(path)

    def _scan_project_files(self) -> None:
        for path in self._project_files():
            if path.suffix.casefold() in SOURCE_SUFFIXES:
                self._record(path)

    def _index_archives(self) -> list[Path]:
        """读取 ZIP central directory；该步骤不解压任何数据成员。"""
        archives: list[Path] = []
        for archive in sorted(
            (path for path in self._project_files() if path.suffix.casefold() == ".zip"),
            key=lambda path: path.as_posix().casefold(),
        ):
            try:
                with zipfile.ZipFile(archive, "r") as bundle:
                    datasets = sorted({
                        Path(info.filename).stem.casefold()
                        for info in bundle.infolist()
                        if not info.is_dir()
                        and Path(info.filename).suffix.casefold() in SOURCE_SUFFIXES
                    })
            except (OSError, zipfile.BadZipFile):
                self.missing_archives.append(archive.relative_to(self.project).as_posix())
                continue
            archives.append(archive)
            relative = archive.relative_to(self.project).as_posix()
            for dataset in datasets:
                self._archive_datasets.setdefault(dataset, []).append(relative)
        return archives

    def _materialize_archives(self, archives: list[Path]) -> None:
        assert self._work is not None
        for index, archive in enumerate(archives):
            destination = self._work / f"archive-{index:04d}"
            try:
                extracted = extract_dataset_archive(
                    self.project,
                    archive,
                    destination,
                    self.credential,
                    include_datasets=self.required_datasets or None,
                )
            except PathPolicyError:
                relative = archive.relative_to(self.project).as_posix()
                if relative not in self.missing_archives:
                    self.missing_archives.append(relative)
                continue
            for path in extracted:
                if path.suffix.casefold() in SOURCE_SUFFIXES:
                    self._record(path)

    def files(self) -> dict[str, list[Path]]:
        files: dict[str, list[Path]] = {}
        for key, paths in self._files.items():
            unique: list[Path] = []
            fingerprints: set[tuple[int, bytes]] = set()
            for path in paths:
                fingerprint = (path.stat().st_size, _file_digest(path))
                if fingerprint in fingerprints:
                    continue
                unique.append(path)
                fingerprints.add(fingerprint)
            files[key] = unique
        return files

    def archive_datasets(self) -> dict[str, list[str]]:
        return {key: list(value) for key, value in self._archive_datasets.items()}
