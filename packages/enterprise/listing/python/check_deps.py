"""检查 Python 依赖是否安装"""
import sys

required = {
    "pandas": "2.0.0",
    "numpy": "1.24.0",
    "openpyxl": "3.1.0",
}

missing = []
outdated = []

for module, min_version in required.items():
    try:
        mod = __import__(module)
        version = getattr(mod, "__version__", "unknown")
        print(f"✓ {module} {version}")
    except ImportError:
        missing.append(module)
        print(f"✗ {module} not found")

if missing:
    print(f"\n请安装缺失的依赖：")
    print(f"pip install {' '.join(missing)}")
    sys.exit(1)

print("\n所有依赖已安装！")
