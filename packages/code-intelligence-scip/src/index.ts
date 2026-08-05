export { createScipCodeIntelligence } from './adapter.js';
export type { ScipCodeIntelligenceOptions } from './adapter.js';

export { createScipProvider } from './provider.js';

export {
  ScipIndexNotFoundError,
  ScipIndexParseError,
  ScipIndexStaleError,
} from './errors.js';

export type {
  CreateScipProviderOptions,
  ScipDocument,
  ScipIndexMetadata,
  ScipIndexState,
  ScipOccurrence,
  ScipProvider,
  ScipReadFile,
  ScipReferenceResult,
  ScipSnapshot,
} from './types.js';
export {
  ScipDocumentSchema,
  ScipIndexMetadataSchema,
  ScipOccurrenceSchema,
  ScipSnapshotSchema,
} from './types.js';
