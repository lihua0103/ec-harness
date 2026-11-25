/** 离线核对：5 张单人图的数据集表内容（不连系统）。 */
import { importParticipantsWorkbook } from '../src/data.js';
import { SINGLE_CHARTS } from '../src/participant-single.js';
const imp = await importParticipantsWorkbook('D:/project/company/ec-clinical-dsh/.runtime/dsh-home/dm-participants/import/cohort-b-e2e.xlsx');
console.log('charts:', SINGLE_CHARTS.map((c) => `${c.key}(${c.columns.length}cols)`).join(' '));
const p = imp.participants[0]!;
console.log('sample participant:', p.id, '| labs:', Object.keys(p.lab ?? {}).length, '| visits:', Object.keys(p.visits ?? {}).length, '| epro:', (p.epro ?? []).length);
console.log('sourceRows:', Object.entries(imp.sourceRows).map(([k, v]) => `${k}=${v.length}`).join(' '));
