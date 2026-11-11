import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdtemp,writeFile,mkdir,rm,symlink,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {zipSync,unzipSync,strToU8} from 'fflate';
// @ts-expect-error Build tooling is deliberately plain JavaScript.
import {buildCandidate,verifyCandidate,approveCandidate} from '../scripts/release-lib.mjs';

test('portable candidate is reproducible, self contained and rejects altered artifacts',async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url));
  const a=await buildCandidate(root),b=await buildCandidate(root);
  assert.deepEqual(a.archive,b.archive);assert.equal(a.manifest.buildDigest,b.manifest.buildDigest);
  assert.equal(verifyCandidate(a.archive).integrity,'VERIFIED');
  assert.equal(a.manifest.distribution,'NOT_APPROVED');
  for(const dependency of a.manifest.bundledPackages) {
    if(dependency.licenseTextStatus!=='PRESENT') assert(a.manifest.distributionBlockers.some((b:{package:string})=>b.package===`${dependency.name}@${dependency.version}`));
  }
  const files=unzipSync(a.archive);const pkg=JSON.parse(Buffer.from(files['package/package.json']).toString());
  assert.equal(pkg.devDependencies,undefined);assert.equal(pkg.dependencies,undefined);assert.equal(pkg.scripts,undefined);
  assert(!Object.keys(files).some(n=>/node_modules|sqlite|credentials|\.map$|tests\//.test(n)));
  const altered={...files,'package/lib/index.js':strToU8('tampered')};
  assert.throws(()=>verifyCandidate(zipSync(altered)),/DIGEST_MISMATCH/);
  assert.throws(()=>verifyCandidate(zipSync({...files,'package/secret.txt':strToU8('must reject')})),/UNEXPECTED_FILE/);
  const missing={...files};delete missing['package/lib/index.js'];
  assert.throws(()=>verifyCandidate(zipSync(missing)),/FILE_SET_CHANGED/);
  assert.throws(()=>verifyCandidate(new Uint8Array([1,2,3])));
  // Import the portable host with only peer services from the pinned host available; no dependency installation.
  const temp=await mkdtemp(join(tmpdir(),'listing-candidate-'));
  try{
    for(const [name,bytes]of Object.entries(files) as [string,Uint8Array][]){
      const relative=name.slice('package/'.length);const path=join(temp,relative);
      await mkdir(join(path,'..'),{recursive:true});await writeFile(path,bytes);
    }
    // Supply only the declared host peers, never the plugin's runtime node_modules.
    // This is a clean-directory loading check, not a full DSH install acceptance.
    await mkdir(join(temp,'node_modules/@deepseek-ai'),{recursive:true});
    for(const peer of Object.keys(pkg.peerDependencies)) {
      await symlink(await realpath(join(root,'node_modules',peer)),join(temp,'node_modules',peer),'junction');
    }
    const result=spawnSync(process.execPath,['--import',import.meta.resolve('tsx'),'--input-type=module','-e','const m = await import(process.argv[1]); if(m.name!=="ec-clinical-dm-listing") process.exit(2)',pathToFileURL(join(temp,'lib/index.js')).href],{cwd:temp,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);

      }finally{await rm(temp,{recursive:true,force:true});}
});

test('distribution approval is an explicit provenance-recorded step on a verified blocker-free candidate',async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url));
  const candidate=await buildCandidate(root);
  assert.equal(candidate.manifest.distribution,'NOT_APPROVED');
  assert.throws(()=>approveCandidate(candidate.archive,'   '),/PROVENANCE_REQUIRED/);
  const approved=approveCandidate(candidate.archive,'当前测试中合成的授权来源');
  assert.equal(approved.manifest.distribution,'APPROVED');
  assert.equal(approved.manifest.distributionApprover,'当前测试中合成的授权来源');
  assert.ok(approved.manifest.distributionApprovedAt);
  assert.equal(approved.manifest.state,'CANDIDATE');
  assert.equal(approved.manifest.productionDataEnabled,false);
  const verified=verifyCandidate(approved.archive);
  assert.equal(verified.integrity,'VERIFIED');
  assert.equal(verified.manifest.buildDigest,candidate.manifest.buildDigest);
  assert.throws(()=>approveCandidate(approved.archive,'再次放行'),/ALREADY_RESOLVED/);
});
