"""
ZIP 归档密码推导（Emerald 规则）

按优先级尝试密码候选：
1. explicit credential (credentialRef)
2. 项目标识符
3. 同目录 sidecar 文件 (*.txt)
4. 归档文件名及其变体
5. 项目内其他文件名
6. 无密码
"""
import re
import zipfile
from pathlib import Path
from typing import Iterable, Optional


def _candidate_tokens(value: str) -> Iterable[str]:
    """从字符串生成密码候选 token"""
    yield value
    stem = Path(value).stem
    if stem != value:
        yield stem
    # 按分隔符拆分
    yield from (part for part in re.split(r"[_/\-.\s]+", stem) if len(part) >= 2)
    # 提取连续数字
    yield from re.findall(r"\d{2,}", stem)


def password_candidates(
    project: Path,
    archive: Path,
    explicit: Optional[str] = None,
) -> list[Optional[bytes]]:
    """
    生成密码候选列表
    
    Args:
        project: 项目根目录
        archive: 归档文件路径
        explicit: 显式提供的密码
    
    Returns:
        密码候选列表（bytes 或 None）
    """
    candidates: list[Optional[bytes]] = []
    seen: set[bytes] = set()
    
    def add_candidate(value: Optional[str]) -> None:
        if value is None:
            if None not in [c for c in candidates if c is None]:
                candidates.append(None)
            return
        for token in _candidate_tokens(value):
            encoded = token.encode("utf-8")
            if encoded not in seen:
                seen.add(encoded)
                candidates.append(encoded)
    
    # 1. explicit credential
    if explicit:
        add_candidate(explicit)
    
    # 2. 项目标识符
    add_candidate(project.name)
    
    # 3. 同目录 sidecar 文件
    archive_dir = archive.parent
    for sidecar in archive_dir.glob("*.txt"):
        if sidecar.is_file():
            try:
                content = sidecar.read_text(encoding="utf-8").strip()
                if content:
                    add_candidate(content)
            except Exception:
                pass
    
    # 4. 归档文件名
    add_candidate(archive.name)
    
    # 5. 项目内其他文件名
    try:
        for path in project.rglob("*"):
            if path.is_file() and path.suffix.lower() in {".txt", ".xlsx", ".xls"}:
                add_candidate(path.stem)
    except Exception:
        pass
    
    # 6. 无密码
    add_candidate(None)
    
    return candidates


def extract_with_password(
    archive_path: Path,
    extract_to: Path,
    project: Path,
    explicit_password: Optional[str] = None,
) -> None:
    """
    尝试解压归档文件
    
    Args:
        archive_path: 归档文件路径
        extract_to: 解压目标目录
        project: 项目根目录
        explicit_password: 显式密码
    
    Raises:
        RuntimeError: 所有密码候选都失败
    """
    candidates = password_candidates(project, archive_path, explicit_password)
    
    last_error = None
    for pwd in candidates:
        try:
            with zipfile.ZipFile(archive_path, 'r') as zf:
                # 测试密码
                zf.testzip()
                # 解压
                zf.extractall(path=extract_to, pwd=pwd)
                return
        except RuntimeError as e:
            # 密码错误
            last_error = e
            continue
        except Exception as e:
            # 其他错误（结构问题等）直接抛出
            raise
    
    # 所有候选都失败
    sidecar_count = sum(1 for _ in archive_path.parent.glob("*.txt"))
    sources = ["project identifier", "archive name", "local file names"]
    if explicit_password:
        sources.insert(0, "credentialRef")
    if sidecar_count:
        sources.append(f"sidecar files ({sidecar_count})")
    
    raise RuntimeError(
        f"Archive credential was not resolved for {archive_path.name}; "
        f"tried local sources: {', '.join(sources)}"
    )
