import { importParticipantsWorkbook } from '../src/data.js';
const imp = await importParticipantsWorkbook('D:/project/company/ec-clinical-dsh/.runtime/dsh-home/dm-participants/import/cohort-b-e2e.xlsx');
const set = new Set((imp.sourceRows['labs'] ?? []).map((r) => String(r.analyte)));
console.log('analytes:', [...set].join(' | '));
