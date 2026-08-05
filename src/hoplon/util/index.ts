/**
 * util/index.ts — barrel re-export of all determinism and boundary utilities.
 */

export { stableStringify } from './stableStringify.js';
export {
  hashManifest,
  hashManifestWithContent,
  hashFileContent,
  addHashPrefix,
  stripHashPrefix,
  HASH_ALGORITHM,
} from './hashManifest.js';
export type { ManifestContentHash } from './hashManifest.js';
export { diagnosticEnvelope } from './diagnosticEnvelope.js';
export type { DiagnosticEnvelope, DiagnosticEnvelopeInput } from './diagnosticEnvelope.js';
export { canonicalizePath } from './canonicalizePath.js';
export type { CanonicalizePathOptions } from './canonicalizePath.js';
export { validateCorrelationId, validateRunId } from './validators.js';
export { canonicalForm } from './canonicalForm.js';
export type { CanonicalFormMode, SerializedCanonicalForm } from './canonicalForm.js';
export { measureConvergence, emitConvergenceEvent } from './convergence.js';
export type { ConvergenceMetrics } from './convergence.js';
export { computeCandidateHash, dedupRetryAttempts } from './retryDedup.js';
export type { RetryCandidate, ParseFn, DetectLangFn } from './retryDedup.js';
export { mergeAstEdits } from './astMerge.js';
export type {
  AstEdit,
  ConflictDescriptor,
  MergeResult,
  MergeResultSuccess,
  MergeResultConflict,
  MergeAstEditsOptions,
} from './astMerge.js';
export {
  exportFineTuningDataset,
  writeFineTuningDatasetToFile,
  defaultQueryFn,
  projectRunQueryFn,
  FineTuningRecordSchema,
} from './fineTuningExport.js';
export type {
  FineTuningRecord,
  ExportFilters,
  ExportOptions,
  WriteOptions,
  QueryFn,
} from './fineTuningExport.js';
