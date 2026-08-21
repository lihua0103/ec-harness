#!/usr/bin/env python3
"""从 security/patterns.py 生成 Node 初筛使用的正则 JSON。"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from security.patterns import NODE_DLP_PATTERNS


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="security/node_patterns.json")
    args = parser.parse_args()

    patterns = [
        {"source": item["re"], "flags": item.get("flags", ""), "label": item["label"]}
        for item in NODE_DLP_PATTERNS
    ]
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(patterns, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
