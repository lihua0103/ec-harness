/** 数据安全开关（手动维护，与模型无关）。
 *
 *  2026-11-24 用户定调：数据安全应是用户自己决定开/关的开关，不该跟着"模型是不是公司的"自动变。
 *  （之前按模型目录自动判定的做法已废弃——换模型会悄悄改变行为，等于替用户做了决定。）
 *
 *  开关文件：`.runtime/data-boundary.json`（仓库根下，手动维护）
 *    { "dataSecurity": true | false }
 *    - true（默认；文件缺失或写错也按此）：脱敏边界生效——Cover / Approval 不读，
 *      TEST CASE 受试者号与 DM/DBD 评审意见只计数，通用读取工具拒读 DVP 模板工作簿；
 *    - false：全量可读，以上内容原值返回。
 *  改开关：node .runtime/data-boundary.cjs on|off|status [--restart]
 *  工具描述与插件提示词在插件加载时按开关选定，所以改完要重启 WebUI 才完全生效；
 *  解析/读取类函数每次调用都读开关。环境变量 DM_DATA_BOUNDARY=full|redacted 仅用于测试覆盖。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type DataBoundaryMode = 'redacted' | 'full';

export const DATA_BOUNDARY_FILE = process.env.DM_DATA_BOUNDARY_FILE
  || fileURLToPath(new URL('../../../.runtime/data-boundary.json', import.meta.url));

export function dataBoundaryMode(): DataBoundaryMode {
  const env = process.env.DM_DATA_BOUNDARY;
  if (env === 'full' || env === 'redacted') return env;
  try {
    const file = process.env.DM_DATA_BOUNDARY_FILE || DATA_BOUNDARY_FILE; // 调用时读取：env 覆盖即时生效
    const config = JSON.parse(readFileSync(file, 'utf8'));
    if (config?.dataSecurity === false) return 'full';
  } catch {
    /* 没有开关文件或文件损坏 = 数据安全开启（安全默认） */
  }
  return 'redacted';
}

/** 关闭数据安全时为 true：工作簿内容（含 Cover / Approval / TEST CASE / 评审意见）原值返回。 */
export const fullAccess = (): boolean => dataBoundaryMode() === 'full';

export const DATA_BOUNDARY_FULL_NOTICE =
  'DATA_BOUNDARY_FULL：本部署已关闭数据安全开关（.runtime/data-boundary.json 的 dataSecurity=false），工作簿内容（含 Cover / Approval / TEST CASE / 评审意见）全量返回。';
