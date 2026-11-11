/** Strict CSV parsing and independently computed expectations for plugin-owned synthetic inputs only. */
import type { Scenario, PkType } from './knowledge.js';
import { ListingError } from './workbook.js';
export const CHECKER_VERSION = 'synthetic-csv-excel-rds-v3';
export interface Check { passed: boolean; code: string; checkerVersion: string; }
export function parseCsv(input: string): string[][] {
  const clean = input.replace(/^﻿/, '');
  input = clean;
  if (Buffer.byteLength(input) > 1024 * 1024) throw new ListingError('OUTPUT_TOO_LARGE');
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false, closed = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"') { if (input[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } }
      else field += c;
    } else if (c === '"' && field === '' && !closed) quoted = true;
    else if (c === ',') { row.push(field); field = ''; closed = false; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && input[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = ''; closed = false;
    } else { if (closed || c === '"') throw new ListingError('OUTPUT_CSV_INVALID'); field += c; }
    if (field.length > 12000 || row.length > 128 || rows.length > 10000) throw new ListingError('OUTPUT_LIMIT');
  }
  if (quoted) throw new ListingError('OUTPUT_CSV_INVALID');
  if (field || row.length || closed) { row.push(field); rows.push(row); }
  if (!rows.length || new Set(rows[0]).size !== rows[0].length || rows.some(r => r.length !== rows[0].length)) throw new ListingError('OUTPUT_CSV_INVALID');
  return rows;
}
export function expectedColumns(scenario: Scenario, pkType?: PkType): string[] {
  return scenario === 'report' ? ['Site','Expected','Complete','CompletionRate']
    : scenario === 'pk' ? ['Subject', ...(pkType === 'be' ? ['Period'] : ['Cohort','NominalDay','Matrix']), 'NominalHour','ActualHour','Concentration']
    : ['Subject','Visit','Value','Unit', ...(scenario === 'manual' ? ['DuplicateFlag'] : [])];
}
/** Expectations are computed by this trusted host checker, never supplied by the generated program. */
export function checkSynthetic(scenario: Scenario, pkType: PkType | undefined, input: string, output: string): Check {
  const fail = (code: string): Check => ({passed:false, code, checkerVersion:CHECKER_VERSION});
  let source: string[][], result: string[][];
  try { source = parseCsv(input); result = parseCsv(output); } catch { return fail('INVALID_OUTPUT_CSV'); }
  const columns = expectedColumns(scenario, pkType);
  if (JSON.stringify(result[0]) !== JSON.stringify(columns)) return fail('COLUMN_CONTRACT_MISMATCH');
  const headers = source[0]; const records = source.slice(1).map(row => Object.fromEntries(headers.map((h,i)=>[h,row[i]])));
  let expected: string[][];
  if (scenario === 'report') {
    const sites = [...new Set(records.map(r=>r.Site))].sort();
    expected = sites.map(site=>{ const group=records.filter(r=>r.Site===site), complete=group.filter(r=>r.Status==='Complete').length;
      return [site,String(group.length),String(complete),String(complete/group.length)]; });
  } else if (scenario === 'pk') {
    expected = records.map(r => {
      const actual=(Date.parse(r.SampleTime)-Date.parse(r.DoseTime))/3600000;
      return [r.Subject,...(pkType==='be'?[r.Period]:[r.Cohort,r.NominalDay,r.Matrix]),r.NominalHour,String(actual),r.Concentration];
    });
  } else {
    const sorted=[...records].sort((a,b)=>a.Subject.localeCompare(b.Subject)||a.Visit.localeCompare(b.Visit));
    expected=sorted.map(r=>[r.Subject,r.Visit,r.Value,r.Unit,...(scenario==='manual'?[records.filter(x=>x.Subject===r.Subject&&x.Visit===r.Visit).length>1?'TRUE':'FALSE']:[])]);
  }
  const rows=result.slice(1);
  if (rows.length !== expected.length) return fail('ROW_COUNT_MISMATCH');
  const numeric = new Set(['Expected','Complete','CompletionRate','NominalHour','ActualHour','NominalDay','Period']);
  for(let i=0;i<rows.length;i++) for(let j=0;j<columns.length;j++) {
    const a=rows[i][j],b=expected[i][j];
    if(numeric.has(columns[j])) {
      if(!a.trim()||!b.trim()||!Number.isFinite(Number(a))||!Number.isFinite(Number(b))||Math.abs(Number(a)-Number(b))>1e-10) return fail('VALUE_CONTRACT_MISMATCH');
    } else if(a!==b) return fail('VALUE_CONTRACT_MISMATCH');
  }
  return {passed:true,code:'SYNTHETIC_CONTRACT_PASSED',checkerVersion:CHECKER_VERSION};
}
