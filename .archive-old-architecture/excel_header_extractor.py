#!/usr/bin/env python3
"""excel_header_extractor.py — security.header_detect 的 CLI 薄壳。

被 Node 端 guard 插件通过子进程调用：
    python3 excel_header_extractor.py <file_path> [<sheet_name>]
        [--max-scan-rows N]

仅输出表头结构，数据区任何值不出域。

stdout: JSON   stderr: 脱敏后的错误   exit 0/1/2
"""
import sys
import os
import argparse

from security.patterns import clean_surrogates, sanitize_error
from security.header_detect import (
    MAX_SCAN_ROWS_DEFAULT,
    process_csv,
    process_xls,
    process_xlsx,
)


def main():
    # 真实故障修复（P0 同源）：zh-CN Windows 默认 cp936 会让中文表头输出
    # 乱码并被 Node 侧按 UTF-8 误读，协议层强制 UTF-8。
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description='Extract header structure from Excel/CSV for DSH guard')
    parser.add_argument('file_path', help='Path to .xlsx / .xls / .csv file')
    parser.add_argument('sheet', nargs='?', default=None, help='Sheet name (xlsx only)')
    parser.add_argument('--max-scan-rows', type=int, default=MAX_SCAN_ROWS_DEFAULT)
    args = parser.parse_args()

    fp = args.file_path
    if not os.path.isfile(fp):
        # FIX-3 (AR-2.9): stderr 不回显原始路径（可能含受试者标记）。
        print(f'file not found: [PATH]', file=sys.stderr)
        sys.exit(1)

    ext = os.path.splitext(fp)[1].lower()
    try:
        if ext == '.xlsx':
            sheets = process_xlsx(fp, args.sheet, args.max_scan_rows)
        elif ext == '.xls':
            sheets = process_xls(fp, args.sheet, args.max_scan_rows)
        elif ext == '.csv':
            sheets = process_csv(fp, args.max_scan_rows)
        else:
            print(f'unsupported extension: {ext}', file=sys.stderr)
            sys.exit(1)
    except SystemExit:
        raise
    except Exception as e:
        # FIX-3 (AR-2.9): 异常原文统一脱敏后再写 stderr。
        print(sanitize_error(e), file=sys.stderr)
        sys.exit(1)

    # FIX-3: 输出 file 字段对文件名做脱敏（文件名可能含受试者标记/孤立代理）。
    output = {'file': sanitize_error(os.path.basename(fp)), 'sheets': sheets}
    # 真实故障修复：cell/sheet 名可携带孤立代理（\udXXX），UTF-8 stdout 直接崩溃。
    print(clean_surrogates(__import__('json').dumps(output, ensure_ascii=False,
                                                    default=str)))


if __name__ == '__main__':
    main()
