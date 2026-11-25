/** Deployment CLI: consistent control-plane backup, verification and restore.
 *
 *  Usage:
 *    node --import tsx src/backup-cli.ts backup --store <control.sqlite> --out <dir> [--artifacts <dir>]
 *    node --import tsx src/backup-cli.ts verify --backup <dir>
 *    node --import tsx src/backup-cli.ts restore --backup <dir> --store <target.sqlite> [--artifacts <dir>]
 *
 *  The target store is never overwritten unless the backup verifies first.
 */
import { backupControlStore, restoreBackup, verifyBackup } from './backup.js';

const args = process.argv.slice(2);
const command = args[0];
const arg = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

try {
  if (command === 'backup') {
    const storePath = arg('store') ?? fail('backup requires --store <control.sqlite>');
    const outDir = arg('out') ?? fail('backup requires --out <directory>');
    const result = await backupControlStore({
      storePath,
      outDir,
      ...(arg('artifacts') ? { artifactsRoot: arg('artifacts') as string } : {}),
    });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } else if (command === 'verify') {
    const backupDir = arg('backup') ?? fail('verify requires --backup <directory>');
    const result = await verifyBackup(backupDir);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(2);
  } else if (command === 'restore') {
    const backupDir = arg('backup') ?? fail('restore requires --backup <directory>');
    const storePath = arg('store') ?? fail('restore requires --store <target.sqlite>');
    const result = await restoreBackup({
      backupDir,
      targetStorePath: storePath,
      ...(arg('artifacts') ? { targetArtifactsRoot: arg('artifacts') as string } : {}),
    });
    console.log(JSON.stringify({ ok: true, restored: storePath, head: result.manifest.store.digest }, null, 2));
  } else {
    fail('usage: backup-cli.ts <backup|verify|restore> ...');
  }
} catch (error) {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exit(1);
}