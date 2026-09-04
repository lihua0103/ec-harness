"""检查 Listing Worker 的 Python 运行期依赖（含最低版本强制）。"""
import re
import sys

required = {"pandas": "2.0.0", "numpy": "1.24.0", "openpyxl": "3.1.0", "pyzipper": "0.2.7"}


def _version_tuple(value: str) -> tuple:
    """'2.3.1rc1' → (2, 3, 1)；只取数字段做保守比较。"""
    return tuple(int(part) for part in re.findall(r"\d+", value)[:3])


missing, outdated = [], []
for module, minimum in required.items():
    try:
        imported = __import__(module)
    except ImportError:
        missing.append(module)
        print(f"ERROR {module} not found")
        continue
    installed = getattr(imported, "__version__", "unknown")
    if installed == "unknown" or _version_tuple(str(installed)) < _version_tuple(minimum):
        outdated.append((module, installed, minimum))
        print(f"ERROR {module} {installed} below required >={minimum}")
    else:
        print(f"OK {module} {installed}")
if missing or outdated:
    print("Install/upgrade missing dependencies: pip install -U " + " ".join(
        missing + [module for module, _, _ in outdated]))
    sys.exit(1)
print("Python dependencies ready")
