/**
 * @deprecated 2026-08-28 由 `dataset-guard.ts` 取代（ADR-0007）：
 * 通用车道数据拦截**回到** tools/pre-execute——按路径引用拒绝数据集文件
 * （.sas7bdat/.xpt/.csv），防 shell/pwsh 绕过 listing 车道。见
 * docs/enterprise/adr/0007-dataset-only-redline-and-lane-guard.md。
 *
 * 本文件保留仅为 git 历史可追溯；不再被 index.ts 引用。
 * Windows 侧可直接删除（G: 挂载沙箱无法 unlink）。
 */
export const name = 'data-interceptor'

export function apply(): void {
  // 退役空实现
}
