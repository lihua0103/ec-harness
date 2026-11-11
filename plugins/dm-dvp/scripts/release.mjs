// dm-dvp release CLI: build | verify | approve. Writes only to the paths given on the
// command line (flag 'wx': never overwrites). CANDIDATE integrity is not deployment
// approval; approve upgrades distribution only, with recorded provenance.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildCandidate, verifyCandidate, approveCandidate } from './release-lib.mjs';

const root = resolve(import.meta.dirname, '..');
const [mode] = process.argv.slice(2);
const out = argvPath(3);
function argvPath(i) { const p = process.argv[i]; if (!p) return null; return resolve(p); }

try {
  if (mode === 'build') {
    if (!out) throw new Usage();
    const { archive, manifest, archiveDigest } = await buildCandidate(root);
    await writeFile(out, archive, { flag: 'wx' });
    console.log(JSON.stringify({ ok: true, state: manifest.state, distribution: manifest.distribution,
      distributionBlockers: manifest.distributionBlockers, archive: out, archiveDigest }, null, 2));
  } else if (mode === 'verify') {
    if (!out) throw new Usage();
    const verified = verifyCandidate(await readFile(out));
    console.log(JSON.stringify({ ok: true, ...verified }, null, 2));
  } else if (mode === 'approve') {
    if (!out) throw new Usage();
    const approvedPath = argvPath(4), provenance = process.argv[5];
    if (!approvedPath || !provenance) throw new Usage();
    const { archive, manifest, archiveDigest } = approveCandidate(await readFile(out), provenance);
    await writeFile(approvedPath, archive, { flag: 'wx' });
    console.log(JSON.stringify({ ok: true, distribution: manifest.distribution,
      distributionApprover: manifest.distributionApprover, state: manifest.state,
      archive: approvedPath, archiveDigest }, null, 2));
  } else throw new Usage();
} catch (error) {
  if (error instanceof Usage) {
    console.error('usage: node scripts/release.mjs build <candidate.zip> | verify <candidate.zip> | approve <candidate.zip> <approved.zip> <provenance>');
    process.exit(64);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
class Usage extends Error {}
