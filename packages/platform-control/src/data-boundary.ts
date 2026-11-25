/** 数据安全开关的服务端读写（平台设置页用）。与模型无关，由用户自己决定开/关。
 *
 *  开关文件与命令行（`.runtime/data-boundary.cjs on|off|status`）和 dm-dvp 插件
 *  （`plugins/dm-dvp/src/data-boundary.ts`）共用同一个文件：`.runtime/data-boundary.json`
 *    { "_comment": "...", "dataSecurity": true | false }
 *  - true（默认；文件缺失或损坏也按此）：脱敏边界生效——Cover / Approval 不读，
 *    TEST CASE 受试者号与 DM/DBD 评审意见只计数，通用读取工具拒读 DVP 模板工作簿；
 *  - false：全量可读，以上内容原值返回。
 *  工具描述与插件提示词在插件加载时按开关选定，所以改完要重启 WebUI 才完全生效。 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA_BOUNDARY_COMMENT = '数据安全开关（手动维护，与模型无关）。dataSecurity=true：脱敏边界生效（Cover/Approval 不读，TEST CASE 与 DM/DBD 评审意见只计数，通用读取工具拒读 DVP 模板）；false：全量可读。改后需重启 WebUI 才完全生效。改法：平台设置页「数据安全」卡片，或命令 node .runtime/data-boundary.cjs on|off|status [--restart]';

/** 仓库根下的开关文件；源码（src/）与构建产物（dist/）到仓库根的相对深度相同。 */
export const DEFAULT_DATA_BOUNDARY_FILE = process.env.EC_DATA_BOUNDARY_FILE
  || fileURLToPath(new URL('../../../.runtime/data-boundary.json', import.meta.url));

export interface DataBoundaryState {
  /** true = 数据安全开启（脱敏边界生效）。 */
  dataSecurity: boolean;
  file: string;
  /** 开关文件是否存在；不存在时按开启处理。 */
  exists: boolean;
}

export function readDataBoundary(file: string = DEFAULT_DATA_BOUNDARY_FILE): DataBoundaryState {
  let dataSecurity = true;
  try {
    dataSecurity = JSON.parse(readFileSync(file, 'utf8'))?.dataSecurity !== false;
  } catch {
    dataSecurity = true; // 文件缺失或损坏 = 数据安全开启（安全默认）
  }
  return { dataSecurity, file, exists: existsSync(file) };
}

/** 写入开关（保留文件里的其他键；原子写）。返回写入后的状态。 */
export function writeDataBoundary(dataSecurity: boolean, file: string = DEFAULT_DATA_BOUNDARY_FILE): DataBoundaryState {
  let extra: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> | null;
    if (parsed && typeof parsed === 'object') {
      extra = Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== '_comment' && key !== 'dataSecurity'));
    }
  } catch {
    /* 没有旧文件或旧文件损坏：按全新写入 */
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ _comment: DATA_BOUNDARY_COMMENT, ...extra, dataSecurity }, null, 2)}\n`);
  renameSync(tmp, file);
  return readDataBoundary(file);
}
