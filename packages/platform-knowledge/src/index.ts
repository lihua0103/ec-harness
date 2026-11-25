/** Platform knowledge bundle entry: exports the core service, contracts and schema types. */
export * from './service.js';
export * from './schema.js';
export * from './manifest.js';
export * from './scope.js';
export * from './identity-scope.js';
export * from './evidence.js';
export * from './preferences.js';
export * from './learning.js';
export { KnowledgeStore, searchText } from './store.js';
export type { CitationRecord, ProjectionRecord, ProjectionOutcome, ReceiptRecord } from './store.js';
export * from './corpus.js';
export {
  computeSnapshotDigest,
  readSnapshot,
  readReleasePointer,
  readActivePreferenceRefs,
  verifySnapshotDigest,
} from './snapshot-readonly.js';
export type { KnowledgeSnapshot, ReadOnlySnapshot } from './snapshot-readonly.js';
export * from './validation-protocol.js';
export * from './knowledge-seeds.js';
export * from './access.js';
export { createKnowledgeServiceServer, headerIdentityAuthenticator, knowledgeErrorStatus } from './http.js';
export type { KnowledgeAuthenticator, KnowledgeServiceServerOptions } from './http.js';
