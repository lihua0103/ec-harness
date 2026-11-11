import { build } from 'esbuild';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { createHash } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { builtinModules } from 'node:module';
import { spawnSync } from 'node:child_process';

export const digest = data => createHash('sha256').update(data).digest('hex');
const stableDate = new Date('2020-01-01T00:00:00Z');
async function walk(root, relative) {
  const directory = await lstat(join(root, relative));
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('RELEASE_DIRECTORY_INVALID');
  const names = [];
  for (const name of (await readdir(join(root, relative))).sort()) {
    const path = `${relative}/${name}`, info = await lstat(join(root, path));
    if (info.isSymbolicLink()) throw new Error('RELEASE_SYMLINK_DENIED');
    if (info.isDirectory()) names.push(...await walk(root, path));
    else if (info.isFile()) names.push(path);
    else throw new Error('RELEASE_SPECIAL_FILE_DENIED');
  }
  return names;
}
async function bundledNotices(root, inputs) {
  const packages = new Map();
  for (const input of Object.keys(inputs)) {
    if (!input.includes('node_modules')) continue;
    let directory=dirname(resolve(root,input));
    for (;;) {
      let pkg;
      try { pkg=JSON.parse(await readFile(join(directory,'package.json'),'utf8')); }
      catch (error) { if (error.code!=='ENOENT') throw error; }
      if (pkg?.name && pkg?.version) {
        const key=`${pkg.name}@${pkg.version}`;
        if (!packages.has(key)) {
          const names=(await readdir(directory)).filter(n=>/^licen[cs]e(?:\.[a-z]+)?$/i.test(n)).sort();
          const pkgText=names.length ? await readFile(join(directory,names[0]),'utf8') : null;
          // Legal text is versioned under licenses/ so builds never depend on mutable node_modules edits.
          const versionedPath=join(root,'licenses',`${key.replaceAll('/','+')}.txt`);
          let versionedText=null;
          try { versionedText=await readFile(versionedPath,'utf8'); }
          catch (error) { if (error.code!=='ENOENT') throw error; }
          const licenseTextStatus = pkgText && versionedText && pkgText!==versionedText ? 'CONFLICT_REQUIRES_REVIEW'
            : pkgText || versionedText ? 'PRESENT' : 'MISSING_REQUIRES_REVIEW';
          const licenseSource = pkgText ? 'INSTALLED_PACKAGE' : versionedText ? 'VERSIONED_LICENSES' : 'MISSING';
          const license = pkgText ?? versionedText
            ?? 'LICENSE TEXT MISSING FROM INSTALLED PACKAGE AND VERSIONED LICENSES. Distribution requires license review; package metadata alone is not the license text.';
          packages.set(key,{name:pkg.name,version:pkg.version,license:pkg.license??'UNKNOWN',
            licenseTextStatus,licenseSource,text:license});
        }
        break;
      }
      const parent=dirname(directory);
      if(parent===directory)throw new Error('BUNDLED_PACKAGE_METADATA_MISSING');
      directory=parent;
    }
  }
  return [...packages.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,pkg])=>pkg);
}
async function sourceInventory(root) {
  const paths = [...await walk(root, 'src'), ...await walk(root, 'knowledge'), ...await walk(root, 'licenses'),
    'package.json', 'pnpm-lock.yaml', 'cordis.patch.yml', 'README.md', 'PROJECTION.md', 'build.mjs',
    'scripts/release-lib.mjs', 'scripts/release.mjs'];
  const workbookRoot=resolve(root,'../../packages/platform-workbook');
  const workbookFiles=['package.json','pnpm-lock.yaml',...await walk(workbookRoot,'src')];
  for(const name of workbookFiles)paths.push(`../../packages/platform-workbook/${name}`);
  const entries = await Promise.all(paths.sort().map(async name => {
    if (!(await lstat(join(root, name))).isFile()) throw new Error('RELEASE_SOURCE_NOT_REGULAR');
    return [name, digest(await readFile(join(root, name)))];
  }));
  return Object.fromEntries(entries);
}
function upstreamIdentity(root) {
  const git = args => {
    const r = spawnSync('git', ['-C', join(root, '../../upstream/deepseek-harness-git'), ...args], {encoding:'utf8', shell:false});
    if (r.error || r.status !== 0) throw new Error('UPSTREAM_BASELINE_UNAVAILABLE');
    return r.stdout.trim();
  };
  const commit = git(['rev-parse','HEAD']);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('UPSTREAM_COMMIT_INVALID');
  // All tracked modifications and untracked nonignored files must be reviewed, not silently blessed.
  if (git(['status','--porcelain','--untracked-files=normal'])) throw new Error('UPSTREAM_WORKTREE_DIRTY');
  return commit;
}

/** A portable bundle, not proof of clean DSH installation or clinical acceptance. No disk writes. */
export async function buildCandidate(root) {
  const [major,minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 9)) throw new Error('NODE_VERSION_UNSUPPORTED');
  const before = await sourceInventory(root), upstreamCommit = upstreamIdentity(root);
  const pkg = JSON.parse(await readFile(join(root,'package.json'),'utf8'));
  const peerDependencies = {...pkg.peerDependencies};
  const host = await build({absWorkingDir:root, entryPoints:['src/index.ts'],bundle:true,
    platform:'node',format:'esm',target:'node24',write:false,metafile:true,
    banner:{js:'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);'},
    external:Object.keys(peerDependencies),alias:{fflate:'fflate/browser'},logLevel:'silent'});
  const client = await build({absWorkingDir:root,entryPoints:['src/client/index.ts'],bundle:true,
    platform:'browser',format:'cjs',target:'es2022',write:false,
    external:['react','@deepseek-ai/dsh-client-ui-primitives'],metafile:true,logLevel:'silent'});
  const bundledPackages=await bundledNotices(root,{...host.metafile.inputs,...client.metafile.inputs});
  for (const output of Object.values(host.metafile.outputs)) for (const entry of output.imports) {
    if (entry.external && !entry.path.startsWith('node:') && !builtinModules.includes(entry.path) && !(entry.path in peerDependencies)) {
      throw new Error(`UNBUNDLED_RUNTIME_DEPENDENCY: ${entry.path}`);
    }
  }
  const runtimePackage = {name:pkg.name,version:pkg.version,description:pkg.description,type:'module',
    main:'./lib/index.js',exports:pkg.exports,files:['lib','knowledge','cordis.patch.yml','README.md','PROJECTION.md','THIRD-PARTY-NOTICES.txt','release-manifest.json'],
    engines:pkg.engines,dsh:pkg.dsh,peerDependencies,license:pkg.license};
  const files = {
    'package/package.json': strToU8(JSON.stringify(runtimePackage,null,2)+'\n'),
    'package/lib/index.js': host.outputFiles[0].contents,
    'package/lib/client.js': strToU8(`window.__ModuleLoader__.load({id:${JSON.stringify(pkg.name)},factory(require){const module={exports:{}};const exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`),
    'package/README.md': new Uint8Array(await readFile(join(root,'README.md'))),
    'package/PROJECTION.md': new Uint8Array(await readFile(join(root,'PROJECTION.md'))),
    'package/THIRD-PARTY-NOTICES.txt': strToU8(bundledPackages.map(p=>`${p.name}@${p.version} (${p.license})\n${p.text}`).join('\n\n----------------\n\n')),
    'package/cordis.patch.yml': new Uint8Array(await readFile(join(root,'cordis.patch.yml'))),
  };
  for (const name of await walk(root,'knowledge')) files[`package/${name}`] = new Uint8Array(await readFile(join(root,name)));
  if (JSON.stringify(before) !== JSON.stringify(await sourceInventory(root)) || upstreamCommit !== upstreamIdentity(root)) {
    throw new Error('RELEASE_SOURCE_CHANGED');
  }
  const checksums = Object.fromEntries(Object.keys(files).sort().map(name=>[name,digest(files[name])]));
  const buildDigest = digest(JSON.stringify({source:before,checksums,upstreamCommit,node:process.versions.node}));
  const manifest = {schemaVersion:1,state:'CANDIDATE',productionDataEnabled:false,name:pkg.name,version:pkg.version,
    buildDigest,upstreamCommit,nodeVersion:process.versions.node,source:before,checksums,
    distribution:'NOT_APPROVED',
    distributionBlockers:bundledPackages.filter(p=>p.licenseTextStatus!=='PRESENT').map(p=>({code:p.licenseTextStatus==='CONFLICT_REQUIRES_REVIEW'?'LICENSE_TEXT_CONFLICT':'LICENSE_TEXT_MISSING',package:`${p.name}@${p.version}`})),
    bundledPackages:bundledPackages.map(({text,...metadata})=>metadata),
    runtimeDependencies:'bundled; DSH peer services supplied by pinned host',
    acceptance:'NOT_RUN',notice:'Candidate integrity is not deployment isolation, business acceptance or release approval.'};
  files['package/release-manifest.json'] = strToU8(JSON.stringify(manifest,null,2)+'\n');
  const sorted = Object.fromEntries(Object.keys(files).sort().map(name=>[name,files[name]]));
  const archive = Buffer.from(zipSync(sorted,{mtime:stableDate,level:9}));
  return {archive,manifest,archiveDigest:digest(archive)};
}

/** Upgrade a VERIFIED, blocker-free candidate to distribution APPROVED with recorded provenance.
 *  buildDigest binds only source+files+upstream, so the approval fields live outside it; state stays
 *  CANDIDATE and productionDataEnabled stays false. Approval is never implied by a clean build. */
export function approveCandidate(archive,provenance) {
  if (typeof provenance!=='string' || !provenance.trim()) throw new Error('APPROVAL_PROVENANCE_REQUIRED');
  const verified=verifyCandidate(archive);
  if (verified.manifest.distributionBlockers.length) throw new Error('DISTRIBUTION_BLOCKERS_OUTSTANDING');
  if (verified.manifest.distribution!=='NOT_APPROVED') throw new Error('DISTRIBUTION_ALREADY_RESOLVED');
  const files=unzipSync(archive);
  const manifest={...verified.manifest,distribution:'APPROVED',
    distributionApprover:provenance.trim(),distributionApprovedAt:new Date().toISOString()};
  const sorted=Object.fromEntries(Object.keys(files).sort().map(name=>[name,
    name==='package/release-manifest.json'?strToU8(JSON.stringify(manifest,null,2)+'\n'):files[name]]));
  const approved=Buffer.from(zipSync(sorted,{mtime:stableDate,level:9}));
  verifyCandidate(approved);
  return {archive:approved,manifest,archiveDigest:digest(approved)};
}

/** Bound archive expansion before decompression; no extraction or execution. */
export function verifyCandidate(archive) {
  if (archive.length > 32*1024*1024) throw new Error('CANDIDATE_TOO_LARGE');
  let total=0;
  const seen=new Set();
  const files=unzipSync(archive,{filter(entry){
    const key=entry.name.toLowerCase();
    if(seen.has(key)||seen.size>=2048)throw new Error('CANDIDATE_DUPLICATE_OR_EXCESS_ENTRIES');
    seen.add(key);
    total+=entry.originalSize;
    if (entry.originalSize>16*1024*1024 || total>64*1024*1024) throw new Error('CANDIDATE_EXPANSION_LIMIT');
    return true;
  }});
  const allowed = name => /^package\/(package\.json|README\.md|PROJECTION\.md|THIRD-PARTY-NOTICES\.txt|cordis\.patch\.yml|release-manifest\.json|lib\/(index|client)\.js|knowledge\/[a-zA-Z0-9_./-]+)$/.test(name)
    && !name.split('/').includes('..') && !name.includes('//');
  if (Object.keys(files).some(name=>!allowed(name))) throw new Error('CANDIDATE_UNEXPECTED_FILE');
  const json = name=>JSON.parse(Buffer.from(files[`package/${name}`]??[]).toString('utf8'));
  const manifest=json('release-manifest.json'),pkg=json('package.json');
  if (manifest.schemaVersion!==1 || manifest.state!=='CANDIDATE' || manifest.productionDataEnabled!==false
    || !/^[a-f0-9]{64}$/.test(manifest.buildDigest) || !/^[a-f0-9]{40}$/.test(manifest.upstreamCommit)
    || manifest.name!==pkg.name || manifest.version!==pkg.version || pkg.devDependencies || pkg.dependencies || pkg.scripts) throw new Error('CANDIDATE_MANIFEST_INVALID');
  const expected=Object.keys(files).filter(n=>n!=='package/release-manifest.json').sort();
  if(JSON.stringify(Object.keys(manifest.checksums??{}).sort())!==JSON.stringify(expected)) throw new Error('CANDIDATE_FILE_SET_CHANGED');
  for(const name of expected) if(digest(files[name])!==manifest.checksums[name])throw new Error('CANDIDATE_DIGEST_MISMATCH');
  for(const required of ['package.json','README.md','PROJECTION.md','THIRD-PARTY-NOTICES.txt','cordis.patch.yml','lib/index.js','lib/client.js']) if(!files[`package/${required}`])throw new Error('CANDIDATE_INCOMPLETE');
  const computed=digest(JSON.stringify({source:manifest.source,checksums:manifest.checksums,upstreamCommit:manifest.upstreamCommit,node:manifest.nodeVersion}));
  if(computed!==manifest.buildDigest)throw new Error('CANDIDATE_BUILD_DIGEST_MISMATCH');
  return {manifest,archiveDigest:digest(archive),integrity:'VERIFIED',acceptance:'NOT_RUN'};
}
