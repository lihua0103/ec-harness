// Build a candidate, verify its internal integrity, or approve distribution with recorded provenance.
// Never installs, publishes or enables real data.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildCandidate, verifyCandidate, approveCandidate } from './release-lib.mjs';

const args=process.argv.slice(2);
const [mode,path,...rest]=args;
let provenance;
if(mode==='approve'&&rest[0]==='--provenance'&&rest.length===2)provenance=rest[1];
if (!path || !['build','verify','approve'].includes(mode)
  || (mode==='approve'?(rest.length!==2||rest[0]!=='--provenance'||typeof provenance!=='string'||!provenance.trim()):rest.length!==0)) {
  console.error('Usage: node scripts/release.mjs build|verify <archive.zip> | approve <archive.zip> --provenance <current-authorization>');process.exit(1);
}
try {
  const target=resolve(path);
  if(mode==='build') {
    const result=await buildCandidate(fileURLToPath(new URL('../',import.meta.url)));
    verifyCandidate(result.archive);
    await writeFile(target,result.archive,{flag:'wx'});
    console.log(JSON.stringify({archive:target,sha256:result.archiveDigest,buildDigest:result.manifest.buildDigest,state:'CANDIDATE',productionDataEnabled:false}));
  } else if(mode==='approve') {
    // The invoking operator supplies provenance for this candidate; a prior authorization is never reused.
    const result=approveCandidate(await readFile(target),provenance);
    const approvedPath=target.replace(/\.zip$/i,'')+'.approved.zip';
    await writeFile(approvedPath,result.archive,{flag:'wx'});
    console.log(JSON.stringify({archive:approvedPath,sha256:result.archiveDigest,buildDigest:result.manifest.buildDigest,distribution:'APPROVED',approver:result.manifest.distributionApprover,approvedAt:result.manifest.distributionApprovedAt,productionDataEnabled:false}));
  } else console.log(JSON.stringify(verifyCandidate(await readFile(target))));
} catch(error) { console.error(error instanceof Error?error.message:'RELEASE_FAILED');process.exitCode=1; }
