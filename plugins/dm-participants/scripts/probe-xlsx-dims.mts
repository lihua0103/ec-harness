/** 核对真正上传的 xlsx 尺寸：列数是否异常膨胀（系统上限 200 列）。 */
import { buildXlsx } from '../../../packages/platform-viz/src/index.js';
import { importParticipantsWorkbook } from '../src/data.js';
import { LABS } from '../src/participant-model.js';
const imp = await importParticipantsWorkbook('D:/project/company/ec-clinical-dsh/.runtime/dsh-home/dm-participants/import/cohort-b-e2e.xlsx');
const headers = LABS.map((l) => l.name.replace(/\s+/g, ''));
const rows: Array<Array<string | number>> = [['PATIENT', 'WEEK', ...headers]];
let n = 0;
for (const r of imp.sourceRows['labs'] ?? []) { rows.push([String(r.participantId), String(r.week), 1, 2, 3, 4, 5]); if (++n > 50) break; }
const buf = buildXlsx(rows, 'PT_LABS_WIDE_V2');
const text = buf.toString('utf8');
const cells = [...text.matchAll(/<c r="([A-Z]+)\d+"/g)].map((m) => m[1]!);
const maxCol = cells.reduce((max, col) => Math.max(max, [...col].reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0)), 0);
console.log('header cols:', rows[0]!.length, '| max column index in xml:', maxCol, '| xml size:', buf.length);
console.log('sample header:', JSON.stringify(rows[0]));
