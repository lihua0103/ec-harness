/** Operator-only offline maintenance; not registered as a model-callable tool. */
import { createBackup, verifyBackup, restoreBackup } from '../src/backup.ts';
const [mode, source, destination] = process.argv.slice(2);
try {
  if (mode === 'verify' && source && !destination) {
    const result = await verifyBackup(source);
    console.log(JSON.stringify({status:'SYNTHETIC_BACKUP_INTEGRITY_VERIFIED',files:Object.keys(result.files).length,productionDataEnabled:false}));
  } else if (mode === 'backup' && source && destination) {
    console.log(JSON.stringify(await createBackup(source,destination)));
  } else if (mode === 'restore' && source && destination) {
    console.log(JSON.stringify(await restoreBackup(source,destination)));
  } else throw new Error('Usage: node --import tsx scripts/maintenance.ts backup|restore <source> <new-directory> OR verify <backup-directory>');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'MAINTENANCE_FAILED'); process.exitCode = 1;
}
