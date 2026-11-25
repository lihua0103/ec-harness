/** Delivery packages (E1-3): sealing ≠ delivering ≠ receiving are three separate, separately
 *  audited facts. A package never silently replaces another; supersession and withdrawal are
 *  explicit operator acts, and the frozen manifest — not a later review — is what a package means.
 */
import { createHash } from 'node:crypto';
import { PlatformError } from './registry.js';
import { canonical, PlatformStore, type DeliveryPackageRecord, type DeliveryPackageState } from './store.js';

const MAX_NOTE = 4000;

/** Transitions that keep the package a live delivery fact. WITHDRAWN and SUPERSEDED are terminal. */
const ACTIVE_STATES: DeliveryPackageState[] = ['SEALED', 'DELIVERED', 'RECEIVED'];

export const deliveryPackageDigest = (record: {
  manifest: DeliveryPackageRecord['manifest'];
}): string => createHash('sha256').update(canonical({ schema: 'delivery-package/v1', ...record })).digest('hex');

const optionalNote = (note: unknown, field: string): string | undefined => {
  if (note === undefined) return undefined;
  if (typeof note !== 'string') throw new PlatformError('DELIVERY_PACKAGE_INVALID', field);
  const trimmed = note.trim();
  if (trimmed.length > MAX_NOTE) throw new PlatformError('DELIVERY_PACKAGE_INVALID', field);
  return trimmed || undefined;
};

export class DeliveryPackageRepository {
  constructor(private readonly store: PlatformStore) {}

  append(record: DeliveryPackageRecord, actor: string): DeliveryPackageRecord {
    return this.store.transaction(() => {
      this.store.packageInsert(record);
      this.store.audit(actor, 'DELIVERY_PACKAGE_SEALED', record.workId, {
        packageId: record.packageId,
        runId: record.runId,
        packageDigest: record.packageDigest,
        artifacts: record.manifest.artifacts.length,
        reviewState: record.manifest.review?.state ?? null,
      });
      return record;
    });
  }

  get(packageId: string): DeliveryPackageRecord | undefined {
    return this.store.packageGet(packageId);
  }

  history(workId: string): DeliveryPackageRecord[] {
    return this.store.packagesForWork(workId);
  }

  /** SEALED → DELIVERED. Recording the act of handing the package over; never reception. */
  deliver(packageId: string, note: unknown, expectedRevision: number, actor: string): DeliveryPackageRecord {
    const noteValue = optionalNote(note, 'note');
    return this.store.transaction(() => this.transition(packageId, expectedRevision, ['SEALED'], 'DELIVERED', actor, 'DELIVERY_PACKAGE_DELIVERED', (record) => ({
      ...record,
      state: 'DELIVERED',
      deliveredAt: new Date().toISOString(),
      ...(noteValue ? { deliveredNote: noteValue } : {}),
    })));
  }

  /** DELIVERED → RECEIVED. A declared counterpart fact; the platform does not verify receipt. */
  acknowledge(packageId: string, note: unknown, expectedRevision: number, actor: string): DeliveryPackageRecord {
    const noteValue = optionalNote(note, 'note');
    return this.store.transaction(() => this.transition(packageId, expectedRevision, ['DELIVERED'], 'RECEIVED', actor, 'DELIVERY_PACKAGE_RECEIVED', (record) => ({
      ...record,
      state: 'RECEIVED',
      receivedAt: new Date().toISOString(),
      ...(noteValue ? { receivedNote: noteValue } : {}),
    })));
  }

  /** SEALED/DELIVERED → WITHDRAWN. The package stops being a live delivery; history stays. */
  withdraw(packageId: string, reason: unknown, expectedRevision: number, actor: string): DeliveryPackageRecord {
    if (typeof reason !== 'string' || !reason.trim()) {
      throw new PlatformError('DELIVERY_PACKAGE_REASON_REQUIRED', 'withdrawal reason');
    }
    const trimmed = reason.trim().slice(0, MAX_NOTE);
    return this.store.transaction(() => this.transition(packageId, expectedRevision, ['SEALED', 'DELIVERED'], 'WITHDRAWN', actor, 'DELIVERY_PACKAGE_WITHDRAWN', (record) => ({
      ...record,
      state: 'WITHDRAWN',
      withdrawnAt: new Date().toISOString(),
      withdrawReason: trimmed,
    })));
  }

  /** Active → SUPERSEDED. The replacing package must be a live package of the same Work. */
  supersede(packageId: string, supersededBy: unknown, expectedRevision: number, actor: string): DeliveryPackageRecord {
    if (typeof supersededBy !== 'string' || !supersededBy) {
      throw new PlatformError('DELIVERY_PACKAGE_SUPERSEDE_INVALID', 'supersededBy');
    }
    if (supersededBy === packageId) {
      throw new PlatformError('DELIVERY_PACKAGE_SUPERSEDE_INVALID', 'a package cannot replace itself');
    }
    return this.store.transaction(() => {
      const replacement = this.store.packageGet(supersededBy);
      if (!replacement || !ACTIVE_STATES.includes(replacement.state) || replacement.workId !== this.store.packageGet(packageId)?.workId) {
        throw new PlatformError('DELIVERY_PACKAGE_SUPERSEDE_INVALID', supersededBy);
      }
      return this.transition(packageId, expectedRevision, ACTIVE_STATES, 'SUPERSEDED', actor, 'DELIVERY_PACKAGE_SUPERSEDED', (record) => ({
        ...record,
        state: 'SUPERSEDED',
        supersededBy,
      }));
    });
  }

  private transition(
    packageId: string,
    expectedRevision: number,
    fromStates: DeliveryPackageState[],
    toState: DeliveryPackageState,
    actor: string,
    auditAction: string,
    mutate: (record: DeliveryPackageRecord) => DeliveryPackageRecord,
  ): DeliveryPackageRecord {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new PlatformError('DELIVERY_PACKAGE_INVALID', 'expectedRevision');
    }
    const record = this.store.packageGet(packageId);
    if (!record) throw new PlatformError('DELIVERY_PACKAGE_NOT_FOUND', packageId);
    if (!fromStates.includes(record.state)) {
      throw new PlatformError('DELIVERY_PACKAGE_STATE', `${record.state} -> ${toState}`);
    }
    const now = new Date().toISOString();
    const next: DeliveryPackageRecord = { ...mutate(record), revision: record.revision + 1, updatedAt: now };
    if (!this.store.packageUpdate(next, expectedRevision)) {
      throw new PlatformError('DELIVERY_PACKAGE_REVISION_STALE');
    }
    this.store.audit(actor, auditAction, record.workId, {
      packageId,
      fromState: record.state,
      toState,
    });
    return next;
  }
}
