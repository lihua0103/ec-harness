/** Artificial, plugin-owned examples. Never derive these records from clinical data. */
import { zipSync, strToU8 } from 'fflate';
import type { Scenario, PkType } from './knowledge.js';
const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
export function makeWorkbook(sheets: Array<{name: string; rows: string[][]}>): Buffer {
  const files: Record<string, Uint8Array> = {};
  files['[Content_Types].xml'] = strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' + sheets.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>');
  files['_rels/.rels'] = strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  files['xl/workbook.xml'] = strToU8('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheets.map((s,i)=>`<sheet name="${escape(s.name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('') + '</sheets></workbook>');
  files['xl/_rels/workbook.xml.rels'] = strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((_,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('') + '</Relationships>');
  sheets.forEach((s,i)=> { files[`xl/worksheets/sheet${i+1}.xml`] = strToU8('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + s.rows.map((row,r)=>`<row r="${r+1}">`+row.map((v,c)=>`<c r="${String.fromCharCode(65+c)}${r+1}" t="inlineStr"><is><t>${escape(v)}</t></is></c>`).join('')+'</row>').join('') + '</sheetData></worksheet>'); });
  return Buffer.from(zipSync(files, { mtime: new Date('2020-01-01T00:00:00Z') }));
}
export interface Demo { workbook: Buffer; specName: string; schema: object; data: string; expected: string; }
export function demo(scenario: Scenario, pkType?: PkType, ambiguous = false): Demo {
  const names = {medical:'Medical Listing Demo Requirements',manual:'Manual Review',report:'DM Status Report Specification',pk:'PK Demo Requirements'};
  const requirement = {
    medical:['M-001','Observation','All scheduled observations','Subject, Visit, Value, Unit','One row per source observation; preserve missing values; sort by Subject then Visit.'],
    manual:['U-001','Observation','Review duplicate observations','Subject, Visit, Value, Unit, DuplicateFlag','Keep all rows. Flag duplicate Subject+Visit keys; do not filter to duplicates.'],
    report:['R-001','PageStatus','Status by site','Site, Expected, Complete, CompletionRate','Denominator is expected pages. Count Complete only; no subject grouping. Zero denominator returns NA.'],
    pk:['P-001','Sample','PK mapping',(pkType==='be'?'Subject, Period':'Subject, Cohort, NominalDay, Matrix')+', NominalHour, ActualHour, Concentration','Use complete sample minus reference dose timestamps in hours; preserve concentration text and BQL. ' + (pkType==='be'?'BE: keep Period and confirm reference dose per period.':'SAD/MAD: retain Cohort, NominalDay and Matrix; confirm reference dose per cohort/day.')],
  }[scenario];
  const rows = [['RequirementId','Form','Condition','Columns','Logic'], requirement];
  const sheets = [{name:'Cover',rows:[['COVER_SYNTHETIC_CANARY']]},{name:names[scenario],rows},{name:'Auxiliary data',rows:[['AUX_SYNTHETIC_CANARY']]}];
  if (ambiguous) sheets.push({name:names[scenario]+' New',rows});
  const pk = scenario==='pk', report = scenario==='report';
  const data = pk ? 'Subject,Period,Cohort,NominalDay,NominalHour,Matrix,DoseTime,SampleTime,Concentration\nSYN001,1,A,1,2,Plasma,2020-01-01T08:00:00Z,2020-01-01T10:00:00Z,BQL\nSYN002,1,A,1,2,Plasma,2020-01-01T08:00:00Z,2020-01-01T10:30:00Z,1.2300\n' : report ? 'Site,Status\nSYN_SITE,Complete\nSYN_SITE,Expected\n' : 'Subject,Visit,Value,Unit\nSYN001,V1,10,mg\nSYN001,V1,11,mg\nSYN002,V2,,mg\n';
  return {workbook:makeWorkbook(sheets),specName:names[scenario],schema:{synthetic:true,source:pk?'Sample':report?'PageStatus':'Observation',fields:data.split('\n')[0].split(','),als:{FormOID:requirement[1],labels:'Use the explicit specification column labels; no patient values in metadata.'}},data,expected:pk?'2,2.5 actual hours; concentration text BQL and 1.2300 retained':report?'SYN_SITE: Expected=2, Complete=1, CompletionRate=0.5':scenario==='manual'?'3 rows; both SYN001/V1 rows flagged; missing SYN002 value retained':'3 observations; missing value retained'};
}
