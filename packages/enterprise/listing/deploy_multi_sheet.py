#!/usr/bin/env python3
"""
部署脚本：将新的多 Sheet 输出功能部署到 listing 插件

使用方法：
    python deploy_multi_sheet.py [--dry-run] [--rollback]
"""
import shutil
from pathlib import Path
import argparse
import sys


def backup_files(base_dir: Path) -> dict:
    """备份现有文件"""
    backups = {}
    
    worker_file = base_dir / "python" / "worker.py"
    index_file = base_dir / "src" / "index.ts"
    
    if worker_file.exists():
        backup_path = worker_file.with_suffix(".py.backup")
        shutil.copy2(worker_file, backup_path)
        backups["worker"] = backup_path
        print(f"✓ 已备份: {worker_file} -> {backup_path}")
    
    if index_file.exists():
        backup_path = index_file.with_suffix(".ts.backup")
        shutil.copy2(index_file, backup_path)
        backups["index"] = backup_path
        print(f"✓ 已备份: {index_file} -> {backup_path}")
    
    return backups


def deploy_new_files(base_dir: Path, dry_run: bool = False) -> bool:
    """部署新文件"""
    worker_new = base_dir / "python" / "worker_new.py"
    worker_target = base_dir / "python" / "worker.py"
    
    index_new = base_dir / "src" / "index_new.ts"
    index_target = base_dir / "src" / "index.ts"
    
    # 检查新文件是否存在
    if not worker_new.exists():
        print(f"✗ 错误: 未找到 {worker_new}")
        return False
    
    if not index_new.exists():
        print(f"✗ 错误: 未找到 {index_new}")
        return False
    
    # 检查 styles 模块
    styles_dir = base_dir / "python" / "styles"
    if not styles_dir.exists():
        print(f"✗ 错误: 未找到 styles 模块: {styles_dir}")
        return False
    
    if dry_run:
        print("\n[DRY RUN] 将执行以下操作:")
        print(f"  - 替换: {worker_target}")
        print(f"  - 替换: {index_target}")
        return True
    
    # 执行替换
    shutil.copy2(worker_new, worker_target)
    print(f"✓ 已部署: {worker_new} -> {worker_target}")
    
    shutil.copy2(index_new, index_target)
    print(f"✓ 已部署: {index_new} -> {index_target}")
    
    return True


def rollback(base_dir: Path) -> bool:
    """回滚到备份版本"""
    worker_backup = base_dir / "python" / "worker.py.backup"
    worker_target = base_dir / "python" / "worker.py"
    
    index_backup = base_dir / "src" / "index.ts.backup"
    index_target = base_dir / "src" / "index.ts"
    
    success = True
    
    if worker_backup.exists():
        shutil.copy2(worker_backup, worker_target)
        print(f"✓ 已回滚: {worker_backup} -> {worker_target}")
    else:
        print(f"✗ 未找到备份: {worker_backup}")
        success = False
    
    if index_backup.exists():
        shutil.copy2(index_backup, index_target)
        print(f"✓ 已回滚: {index_backup} -> {index_target}")
    else:
        print(f"✗ 未找到备份: {index_backup}")
        success = False
    
    return success


def verify_deployment(base_dir: Path) -> bool:
    """验证部署"""
    checks = []
    
    # 检查文件存在性
    worker = base_dir / "python" / "worker.py"
    index = base_dir / "src" / "index.ts"
    styles_init = base_dir / "python" / "styles" / "__init__.py"
    
    checks.append(("worker.py", worker.exists()))
    checks.append(("index.ts", index.exists()))
    checks.append(("styles/__init__.py", styles_init.exists()))
    
    # 检查关键内容
    if worker.exists():
        content = worker.read_text(encoding='utf-8')
        checks.append(("worker.py contains create_multi_sheet_excel", 
                      "create_multi_sheet_excel" in content))
        checks.append(("worker.py contains operation_merge", 
                      "operation_merge" in content))
    
    if index.exists():
        content = index.read_text(encoding='utf-8')
        checks.append(("index.ts contains enterprise_listing_merge", 
                      "enterprise_listing_merge" in content))
    
    print("\n验证结果:")
    all_passed = True
    for name, passed in checks:
        status = "✓" if passed else "✗"
        print(f"  {status} {name}")
        if not passed:
            all_passed = False
    
    return all_passed


def main():
    parser = argparse.ArgumentParser(description="部署多 Sheet 输出功能")
    parser.add_argument("--dry-run", action="store_true", 
                       help="模拟运行，不实际修改文件")
    parser.add_argument("--rollback", action="store_true", 
                       help="回滚到备份版本")
    parser.add_argument("--base-dir", type=str, 
                       default=r"G:\home\dsh-guard\packages\enterprise\listing",
                       help="listing 插件基础目录")
    
    args = parser.parse_args()
    base_dir = Path(args.base_dir)
    
    if not base_dir.exists():
        print(f"✗ 错误: 目录不存在: {base_dir}")
        return 1
    
    print(f"工作目录: {base_dir}\n")
    
    if args.rollback:
        print("=== 执行回滚 ===")
        if rollback(base_dir):
            print("\n✓ 回滚成功")
            return 0
        else:
            print("\n✗ 回滚失败")
            return 1
    
    print("=== 开始部署 ===\n")
    
    # 1. 备份
    print("步骤 1: 备份现有文件")
    backups = backup_files(base_dir)
    
    # 2. 部署
    print("\n步骤 2: 部署新文件")
    if not deploy_new_files(base_dir, dry_run=args.dry_run):
        print("\n✗ 部署失败")
        return 1
    
    if args.dry_run:
        print("\n[DRY RUN] 未实际修改文件")
        return 0
    
    # 3. 验证
    print("\n步骤 3: 验证部署")
    if not verify_deployment(base_dir):
        print("\n⚠ 验证未完全通过，可能需要手动检查")
        print("  如需回滚，运行: python deploy_multi_sheet.py --rollback")
        return 1
    
    print("\n✓ 部署成功!")
    print("\n后续步骤:")
    print("  1. 编译 TypeScript: cd packages/enterprise/listing && pnpm build")
    print("  2. 运行测试项目验证功能")
    print("  3. 如需回滚: python deploy_multi_sheet.py --rollback")
    
    return 0


if __name__ == "__main__":
    sys.exit(main())
