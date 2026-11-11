/** Versioned artificial-fixture output contract, not a universal clinical schema. */
import { expectedColumns } from './checker.js';
import type { Scenario, PkType } from './knowledge.js';
export const OUTPUT_CONTRACT_VERSION = 'synthetic-excel-rds-v1';
export const R_PACKAGE_LOCK = {openxlsx:'4.2.8.1', Rcpp:'1.1.1', stringi:'1.8.7', zip:'2.3.3'} as const;
export type ColumnType = 'character' | 'numeric' | 'logical';
export function outputContract(scenario: Scenario, pkType?: PkType) {
  const numeric = new Set(['Expected','Complete','CompletionRate','Period','NominalDay','NominalHour','ActualHour']);
  return {version:OUTPUT_CONTRACT_VERSION,files:['output.csv','output.xlsx','output.rds'],sheet:'Listing',
    columns:expectedColumns(scenario,pkType).map(name=>({name,type:(name==='DuplicateFlag'?'logical':numeric.has(name)?'numeric':'character') as ColumnType,
      nullable:name==='Value'})),
    missing:'Value missing is NA in RDS, blank in CSV/Excel; concentration text is not numerically coerced.',
    rds:{serializationVersion:2,encoding:'uncompressed XDR',object:'plain data.frame; no column classes or custom attributes'},
    dependencies:R_PACKAGE_LOCK};
}
/** Fixed version checks; no network, profile or automatic package installation. */
export const dependencyProbeR = Object.entries(R_PACKAGE_LOCK).map(([name,version])=>
  `if (!requireNamespace("${name}", quietly=TRUE) || as.character(utils::packageVersion("${name}")) != "${version}") stop("OUTPUT_DEPENDENCY_MISMATCH")`).join('\n');
