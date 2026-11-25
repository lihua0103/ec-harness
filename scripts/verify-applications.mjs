// 平台侧应用登记检查：把每个插件的 application.json 组装成 AppReleaseDraft，
// 经控制面登记并回读 ACTIVE。只证明清单与登记链路一致，不证明业务验收或工作台部署可见。
// 字段映射一律走 platform-control 的共享清单转换（release-manifest），本脚本不自行挑字段。
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformControlService, buildAppReleaseDraft, directoryDigest, pluginIdFrom, verificationBundleDigest } from '../packages/platform-control/lib/index.js';

const root = process.cwd();

function pluginDirectories() {
  const base = join(root, 'plugins');
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(base, entry.name))
    .sort();
}

const drafts = [];
const problems = [];
for (const directory of pluginDirectories()) {
  const applicationPath = join(directory, 'application.json');
  const manifestPath = join(directory, 'package.json');
  if (!existsSync(applicationPath) || !existsSync(manifestPath)) continue;
  const application = JSON.parse(readFileSync(applicationPath, 'utf8'));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const label = manifest.name ?? directory;
  if (!application.capabilityId) {
    problems.push(`${label}: application.json missing capabilityId`);
    continue;
  }
  const libDir = join(directory, 'lib');
  if (!existsSync(join(libDir, 'index.js'))) {
    problems.push(`${label}: lib/index.js missing (run build before this check)`);
    continue;
  }
  const artifactDigest = directoryDigest(libDir);
  const patchPath = join(directory, 'cordis.patch.yml');
  const pluginId = pluginIdFrom(manifest, existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : undefined);
  try {
    const { draft, versions } = buildAppReleaseDraft({
      application,
      manifest,
      pluginId,
      artifactDigest,
      runtimeBundleDigest: verificationBundleDigest({
        appId: application.appId,
        version: manifest.version,
        artifactDigest,
      }),
    });
    drafts.push({ label, draft, versions });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    problems.push(`${label}: ${code} ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (drafts.length === 0) problems.push('no plugin declares application.json');

const temporary = mkdtempSync(join(tmpdir(), 'verify-applications-'));
const service = new PlatformControlService(join(temporary, 'control.sqlite'), null, undefined, {
  requireArtifacts: true,
});
const operator = { actorId: 'session:verify-applications', kind: 'operator' };
let registered = 0;
try {
  for (const { label, draft, versions } of drafts) {
    try {
      const record = service.registerApp(draft, operator);
      const readBack = service
        .listApps('ACTIVE', operator)
        .find((app) => app.appId === record.appId && app.appVersion === record.appVersion);
      if (!readBack || readBack.state !== 'ACTIVE') {
        problems.push(`${label}: registered but not ACTIVE on read-back`);
        continue;
      }
      registered++;
      const axes = `app=${versions.appVersion} cap=${versions.capabilityId}@${versions.capabilityVersion} pkg=${versions.pluginId}@${versions.pluginVersion}`;
      console.log(
        `OK ${record.appId}@${record.appVersion} release=${record.releaseDigest.slice(0, 12)} plan=${record.plan.planDigest.slice(0, 12)} [${axes}]`,
      );
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      problems.push(`${label}: ${code} ${error instanceof Error ? error.message : String(error)}`);
    }
  }
} finally {
  service.close();
  rmSync(temporary, { recursive: true, force: true });
}

console.log(`${registered}/${drafts.length} applications registered`);
if (problems.length) {
  console.error('FAILED:');
  for (const problem of problems) console.error(`- ${problem}`);
  process.exitCode = 1;
}
