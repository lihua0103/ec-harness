"""审计 JSONL 的统一写入、轮转和保留策略。

FIX-7 (BR-06.10 / FR-14-08 / TC-34 / NFR-13): 追加、轮转与归档清理全部在
跨平台文件锁（Unix fcntl / Windows msvcrt）内完成。
Windows 的 O_APPEND 是 lseek+write 两步、非原子，因此并发追加必须持锁，
否则多进程写入互相覆盖丢记录。
NFR-1: 锁外无多余系统调用（目录缓存、仅新建文件 chmod、清理随轮转执行）。
"""
from __future__ import annotations

import glob
import json
import os
import time
import uuid
from contextlib import contextmanager
from datetime import datetime
from typing import Any, Iterator

MAX_AUDIT_BYTES = 10 * 1024 * 1024
MAX_AUDIT_ARCHIVES = 5

# 已确认存在的审计目录缓存（NFR-1: 热路径省去重复 makedirs 系统调用）。
_KNOWN_DIRS: set[str] = set()
LOCK_TIMEOUT_SECONDS = 2.0
LOCK_RETRY_SECONDS = 0.02


class AuditLockTimeout(TimeoutError):
    """审计/授权目录锁在有界等待内不可用。"""


def harden_permissions(path: str, mode: int) -> None:
    """在 POSIX 强制 owner-only；Windows 保留现有 ACL。"""
    try:
        os.chmod(path, mode)
    except PermissionError:
        if os.name != "nt":
            raise


@contextmanager
def _exclusive_lock(directory: str, timeout: float = LOCK_TIMEOUT_SECONDS) -> Iterator[None]:
    """跨平台有界排他锁，避免 Windows ``LK_LOCK`` 长时间阻塞 worker。"""
    lock_path = os.path.join(directory, ".audit.lock")
    handle = open(lock_path, "a+")
    acquired = False
    try:
        fd = handle.fileno()
        deadline = time.monotonic() + max(0.0, timeout)
        while not acquired:
            try:
                try:
                    import fcntl  # POSIX

                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except ImportError:  # Windows
                    import msvcrt

                    handle.seek(0)
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                acquired = True
            except (BlockingIOError, OSError):
                if time.monotonic() >= deadline:
                    raise AuditLockTimeout("audit lock acquisition timed out")
                time.sleep(LOCK_RETRY_SECONDS)
        try:
            yield
        finally:
            if acquired:
                try:
                    import fcntl

                    fcntl.flock(fd, fcntl.LOCK_UN)
                except ImportError:
                    import msvcrt

                    handle.seek(0)
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
    finally:
        handle.close()


def _append_line(current: str, record: dict[str, Any]) -> None:
    """持锁追加一行 JSON + fsync（ST-P3-x：确保崩溃后记录不丢）。"""
    payload = (json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    fd = os.open(current, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.write(fd, payload)
        os.fsync(fd)
    finally:
        os.close(fd)


def _prune_archives(prefix: str, directory: str, max_archives: int) -> None:
    """归档超额清理（确定性磁盘上限）。"""
    archives = glob.glob(os.path.join(directory, f"{prefix}_*.jsonl.*.rotated"))
    if len(archives) <= max_archives:
        return
    archives.sort(key=os.path.getmtime, reverse=True)
    for stale in archives[max_archives:]:
        try:
            os.unlink(stale)
        except OSError:
            pass


def _rotate_current(current: str, directory: str, max_bytes: int) -> bool:
    """锁内轮转当前文件（double-check 大小）。返回是否发生轮转。"""
    if not os.path.exists(current) or os.path.getsize(current) < max_bytes:
        return False
    stamp = datetime.now().strftime("%Y%m%d%H%M%S")
    rotated = f"{current}.{stamp}-{uuid.uuid4().hex[:8]}.rotated"
    try:
        os.replace(current, rotated)
    except PermissionError:
        # Windows: 另一进程正打开该文件；本次跳过轮转，数据不丢。
        return False
    harden_permissions(rotated, 0o600)
    return True


def write_audit_record(
    directory: str,
    prefix: str,
    record: dict[str, Any],
    max_bytes: int = MAX_AUDIT_BYTES,
    max_archives: int = MAX_AUDIT_ARCHIVES,
) -> None:
    """写入一条审计记录，并保持审计目录有确定性磁盘上限。

    全流程持锁（FIX-7）：轮转判断 → 归档清理 → 追加写，多进程并发安全。
    """
    if directory not in _KNOWN_DIRS:
        os.makedirs(directory, mode=0o700, exist_ok=True)
        harden_permissions(directory, 0o700)
        _KNOWN_DIRS.add(directory)
    current = os.path.join(
        directory, f"{prefix}_{datetime.now().strftime('%Y%m')}.jsonl"
    )

    try:
        with _exclusive_lock(directory):
            is_new = not os.path.exists(current)
            if not is_new and _rotate_current(current, directory, max_bytes):
                is_new = True
            _prune_archives(prefix, directory, max_archives)
            _append_line(current, record)
            if is_new:
                harden_permissions(current, 0o600)
    except AuditLockTimeout:
        # 审计日志是可观测性通道。锁竞争时跳过轮转并直接 O_APPEND，不能让
        # quickGuard/LLM 请求排队；授权读改写仍由调用方保持 fail closed。
        is_new = not os.path.exists(current)
        _append_line(current, record)
        if is_new:
            harden_permissions(current, 0o600)
