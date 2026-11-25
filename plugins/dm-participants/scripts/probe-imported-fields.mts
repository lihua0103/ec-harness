/** 工作簿导入后，参与者对象里哪些字段有数据（决定 8 张设计图哪几张可落）。 */
import { importParticipantsWorkbook } from '../src/data.js';
const imp = await importParticipantsWorkbook('D:/project/company/ec-clinical-dsh/.runtime/dsh-home/dm-participants/import/cohort-b-e2e.xlsx');
const p = imp.participants[0]!;
console.log('id:', p.id, '| site:', p.site, '| weeks:', p.weeks, '| status:', p.status);
console.log('lab analytes:', Object.keys(p.lab ?? {}).join(','));
console.log('lab points per analyte:', Object.values(p.lab ?? {}).map((v) => v.length).join(','));
console.log('visits:', JSON.stringify(p.visits).slice(0, 160));
console.log('doseSegs:', JSON.stringify(p.doseSegs).slice(0, 160));
console.log('aes:', JSON.stringify(p.aes).slice(0, 160));
console.log('epro:', JSON.stringify(p.epro).slice(0, 80), '| adherence:', p.adherence, '| consentGap:', p.consentGap);
console.log('queries:', JSON.stringify(p.queries), '| pills:', JSON.stringify(p.pills));
