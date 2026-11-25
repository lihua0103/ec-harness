/** Consistent backup and verified restore for the control-plane store.
 *
 *  SQLite is backed up with `VACUUM INTO`, which produces a transactionally consistent copy even
 *  while WAL is active. Sealed artifacts are copied byte-for-byte and every file is digested in a
 *  manifest, so a restore can prove it restored exactly what was backed up.
 *
 *  This is a deployment capability, not a high-availability story: it does not stream, replicate
 *  or schedule itself, and it does not claim an RPO/RTO.
 */
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { PlatformError } from './registry.js';

export interface BackupManifest {
  format: 'platform-control-backup/v1';
  createdAt: string;
  store: { file: string; bytes: number; digest: string };
  artifacts?: { files: number; bytes: number; digest: string };
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/** Relative-path + content digest tree, stable across platforms (forward slashes, sorted). */
async function treeDigest(root: string): Promise<{ files: number; bytes: number; digest: string }> {
  const entries: Array<{ path: string; digest: string; bytes: number }> = [];
  const walk = async (directory: string): Promise<void> => {
    const items = await readdir(directory, { withFileTypes: true });
    for (const item of items.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = join(directory, item.name);
      if (item.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!item.isFile()) continue;
      const data = await readFile(absolute);
      entries.push({
        path: relative(root, absolute).split('\\').join('/'),
        digest: sha256(data),
        bytes: data.length,
      });
    }
  };
  if (!(await stat(root).then((info) => info.isDirectory()).catch(() => false))) {
    return { files: 0, bytes: 0, digest: sha256(Buffer.alloc(0)) };
  }
  await walk(root);
  const digest = sha256(Buffer.from(JSON.stringify(entries), 'utf8'));
  return {
    files: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    digest,
  };
}

export interface BackupResult {
  outDir: string;
  manifestPath: string;
  manifest: BackupManifest;
}

/**
 * Copy the control store and (when provided) the sealed-artifact root into a new directory.
 * The target must be empty or absent; an existing backup is never silently overwritten.
 */
export async function backupControlStore(options: {
  storePath: string;
  artifactsRoot?: string;
  outDir: string;
  now?: Date;
}): Promise<BackupResult> {
  const outDir = resolve(options.outDir);
  await mkdir(dirname(outDir), { recursive: true });
  const existing = await readdir(outDir).catch(() => [] as string[]);
  if (existing.length > 0) throw new PlatformError('BACKUP_TARGET_NOT_EMPTY', outDir);
  await mkdir(outDir, { recursive: true });

  const storeFile = 'control.sqlite';
  const target = join(outDir, storeFile);
  const db = new DatabaseSync(resolve(options.storePath), { allowExtension: false });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
  const storeData = await readFile(target);
  const manifest: BackupManifest = {
    format: 'platform-control-backup/v1',
    createdAt: (options.now ?? new Date()).toISOString(),
    store: { file: storeFile, bytes: storeData.length, digest: sha256(storeData) },
  };
  if (options.artifactsRoot) {
    const artifactsTarget = join(outDir, 'artifacts');
    await cp(resolve(options.artifactsRoot), artifactsTarget, { recursive: true, force: false, errorOnExist: false });
    manifest.artifacts = await treeDigest(artifactsTarget);
  }
  const manifestPath = join(outDir, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { outDir, manifestPath, manifest };
}

export interface BackupVerification {
  ok: boolean;
  manifest: BackupManifest;
  problems: string[];
}

/** Recompute every digest a backup claims; any mismatch is reported, never repaired in place. */
export async function verifyBackup(outDir: string): Promise<BackupVerification> {
  const root = resolve(outDir);
  const problems: string[] = [];
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as BackupManifest;
  } catch {
    throw new PlatformError('BACKUP_MANIFEST_MISSING', root);
  }
  if (manifest.format !== 'platform-control-backup/v1') problems.push('FORMAT_UNSUPPORTED');
  try {
    const data = await readFile(join(root, manifest.store.file));
    if (data.length !== manifest.store.bytes) problems.push('STORE_BYTES_MISMATCH');
    if (sha256(data) !== manifest.store.digest) problems.push('STORE_DIGEST_MISMATCH');
  } catch {
    problems.push('STORE_MISSING');
  }
  if (manifest.artifacts) {
    const actual = await treeDigest(join(root, 'artifacts'));
    if (actual.files !== manifest.artifacts.files) problems.push('ARTIFACT_FILE_COUNT_MISMATCH');
    if (actual.bytes !== manifest.artifacts.bytes) problems.push('ARTIFACT_BYTES_MISMATCH');
    if (actual.digest !== manifest.artifacts.digest) problems.push('ARTIFACT_DIGEST_MISMATCH');
  }
  return { ok: problems.length === 0, manifest, problems };
}

/**
 * Restore a verified backup into a target directory. The store is staged and renamed, so a failed
 * restore never leaves a half-written database at the target path.
 */
export async function restoreBackup(options: { backupDir: string; targetStorePath: string; targetArtifactsRoot?: string }): Promise<BackupVerification> {
  const verification = await verifyBackup(options.backupDir);
  if (!verification.ok) throw new PlatformError('BACKUP_VERIFY_FAILED', verification.problems.join(','));
  const target = resolve(options.targetStorePath);
  await mkdir(dirname(target), { recursive: true });
  const staged = `${target}.restoring-${process.pid}-${Date.now()}`;
  try {
    await cp(join(resolve(options.backupDir), verification.manifest.store.file), staged);
    await rename(staged, target);
  } catch (error) {
    await rm(staged, { force: true });
    throw error;
  }
  if (verification.manifest.artifacts && options.targetArtifactsRoot) {
    const artifactsRoot = resolve(options.targetArtifactsRoot);
    await mkdir(artifactsRoot, { recursive: true });
    await cp(join(resolve(options.backupDir), 'artifacts'), artifactsRoot, { recursive: true });
  }
  return verification;
}