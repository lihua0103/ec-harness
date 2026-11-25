/** 核对宽表列数（系统上限 200 列）与当前队列状态。 */
import { importParticipantsWorkbook } from '../src/data.js';
const imp = await importParticipantsWorkbook('D:/project/company/ec-clinical-dsh/.runtime/dsh-home/dm-participants/import/cohort-b-e2e.xlsx');
const labs = imp.sourceRows['labs'] ?? [];
const analytes = new Set(labs.map((r) => String(r.analyte)));
console.log('labs long rows:', labs.length, '| distinct analytes:', analytes.size, '|', [...analytes].join(','));
console.log('wide table columns = PATIENT + WEEK + ' + analytes.size + ' = ' + (2 + analytes.size));
