/** Hand-authored acceptance programs, never supplied to the generating model or used as an AI fallback. */
import type { Scenario, PkType } from '../../src/knowledge.js';
export function referenceProgram(scenario: Scenario, pkType?: PkType): string {
  const start = `args <- commandArgs(trailingOnly=TRUE)
d <- read.csv(args[1], colClasses="character", na.strings=NULL, check.names=FALSE)
`;
  const body = scenario === 'report' ? `sites <- sort(unique(d$Site))
o <- do.call(rbind, lapply(sites, function(site) {
  g <- d[d$Site == site, , drop=FALSE]
  data.frame(Site=site, Expected=nrow(g), Complete=sum(g$Status == "Complete"), CompletionRate=sum(g$Status == "Complete") / nrow(g))
}))
` : scenario === 'pk' ? `dose <- as.POSIXct(d$DoseTime, format="%Y-%m-%dT%H:%M:%SZ", tz="UTC")
sample <- as.POSIXct(d$SampleTime, format="%Y-%m-%dT%H:%M:%SZ", tz="UTC")
d$ActualHour <- as.numeric(difftime(sample, dose, units="hours"))
o <- d[, c("Subject", ${pkType === 'be' ? '"Period"' : '"Cohort", "NominalDay", "Matrix"'}, "NominalHour", "ActualHour", "Concentration"), drop=FALSE]
` : `d <- d[order(d$Subject, d$Visit), , drop=FALSE]
${scenario === 'manual' ? 'key <- paste(d$Subject, d$Visit, sep="|")\nd$DuplicateFlag <- duplicated(key) | duplicated(key, fromLast=TRUE)\n' : ''}o <- d
`;
  const numeric = scenario==='report'?['Expected','Complete','CompletionRate']:scenario==='pk'?[...(pkType==='be'?['Period']:['NominalDay']),'NominalHour','ActualHour']:[];
  return `${start}${body}${numeric.map(n=>`o$${n} <- as.numeric(o$${n})`).join('\n')}
${scenario==='medical'||scenario==='manual'?'o$Value[o$Value == ""] <- NA_character_':''}
write.csv(o, args[2], row.names=FALSE, na="")
openxlsx::write.xlsx(list(Listing=o), "output.xlsx", overwrite=FALSE, rowNames=FALSE, keepNA=FALSE)
saveRDS(o, "output.rds", version=2, compress=FALSE)
`;
}
