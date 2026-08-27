"""检查 Listing Worker 的 Python 运行期依赖。"""
import sys

required = {"pandas": "2.0.0", "numpy": "1.24.0", "openpyxl": "3.1.0"}
missing = []
for module in required:
    try:
        imported = __import__(module)
        print(f"OK {module} {getattr(imported, '__version__', 'unknown')}")
    except ImportError:
        missing.append(module)
        print(f"ERROR {module} not found")
if missing:
    print("Install missing dependencies: pip install " + " ".join(missing))
    sys.exit(1)
print("Python dependencies ready")
