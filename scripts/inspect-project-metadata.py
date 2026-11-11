"""Read a project directory and XLSX workbook metadata, never cell/shared-string content.
Run with python -I; supply an explicitly authorized project directory.
"""
import argparse
import json
import os
from pathlib import Path, PurePosixPath
import sys
import zipfile

# Resolve only the project-owned, pinned parser installation, never the inspected directory.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / '.tools' / 'metadata-python'))
from defusedxml import ElementTree as ET


def metadata(path):
    opened = []
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        names = [i.filename for i in infos]
        if len(names) > 10000 or len(set(names)) != len(names):
            raise ValueError("INVALID_CONTAINER_DIRECTORY")
        for info in infos:
            p = PurePosixPath(info.filename)
            if p.is_absolute() or ".." in p.parts or "\\" in info.filename:
                raise ValueError("INVALID_ENTRY_PATH")
        name = "xl/workbook.xml"
        info = archive.getinfo(name)
        if info.file_size > 1024 * 1024 or info.flag_bits & 1:
            raise ValueError("UNSUPPORTED_METADATA")
        opened.append(name)
        data = archive.read(info)
        if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
            raise ValueError("XML_DECLARATION_DENIED")
        document = ET.fromstring(data)
        ns = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
        sheets = [{"name": s.attrib.get("name", ""), "state": s.attrib.get("state", "visible")}
                  for s in document.findall("s:sheets/s:sheet", ns)]
        if len(sheets) > 256 or any(len(s["name"]) > 128 for s in sheets):
            raise ValueError("METADATA_LIMIT")
        return {"sheets": sheets, "entriesRead": opened, "worksheetContentRead": False,
                "sharedStringsRead": False}


def inspect(root):
    program = root / "SAS_Program" / "SAS_program" / "Manual Listing"
    if not program.is_dir() or program.is_symlink():
        raise ValueError("PROGRAM_DIRECTORY_NOT_FOUND")
    results = []
    for path in sorted(program.iterdir()):
        if path.suffix.lower() != ".xlsx" or path.name.startswith("~$") or path.is_symlink():
            continue
        if path.stat().st_size > 64 * 1024 * 1024:
            results.append({"file": str(path.relative_to(root)), "status": "FILE_SIZE_LIMIT"})
            continue
        try:
            results.append({"file": str(path.relative_to(root)), "status": "METADATA_ONLY", **metadata(path)})
        except Exception:
            results.append({"file": str(path.relative_to(root)), "status": "METADATA_UNAVAILABLE"})
    return {"inspection": "AUTHORIZED_METADATA_ONLY", "workbooks": results,
            "protectedDirectoriesOpened": False, "projectFilesModified": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("project_directory", type=Path)
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(inspect(args.project_directory.resolve(strict=True)), ensure_ascii=False, indent=2))
