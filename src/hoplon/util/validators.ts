/**
 * util/validators.ts — Pure validation functions for IDs.
 *
 * Validates correlationId and runId at the contract boundary before they
 * reach the engine. These are called before the engine is fully constructed,
 * so errors use sentinel values:
 *   - engineId: 'validator'
 *   - correlationId: 'validator'
 *
 * ## Rules
 * Both IDs:
 *   - Must be non-empty
 *   - Must not be whitespace-only
 *   - Must not exceed 256 characters
 */

import { ValidationError } from '../contracts/errors.js';

const MAX_ID_LENGTH = 256;

/**
 * Validate a correlationId string.
 * @throws {ValidationError} with kind 'invalid_correlation_id' on failure.
 */
export function validateCorrelationId(id: string): void {
  if (!id || id.trim().length === 0) {
    throw new ValidationError(
      {
        kind: 'invalid_correlation_id',
        engineId: 'validator',
        correlationId: 'validator',
        cause: { value: id, reason: 'empty_or_whitespace' },
      },
      `correlationId must be a non-empty, non-whitespace string`,
    );
  }
  if (id.length > MAX_ID_LENGTH) {
    throw new ValidationError(
      {
        kind: 'invalid_correlation_id',
        engineId: 'validator',
        correlationId: 'validator',
        cause: { value: id.substring(0, 32) + '...', length: id.length, max: MAX_ID_LENGTH },
      },
      `correlationId must not exceed ${MAX_ID_LENGTH} characters; got ${id.length}`,
    );
  }
}

/**
 * Validate a runId string.
 * @throws {ValidationError} with kind 'invalid_run_id' on failure.
 */
export function validateRunId(id: string): void {
  if (!id || id.trim().length === 0) {
    throw new ValidationError(
      {
        kind: 'invalid_run_id',
        engineId: 'validator',
        correlationId: 'validator',
        cause: { value: id, reason: 'empty_or_whitespace' },
      },
      `runId must be a non-empty, non-whitespace string`,
    );
  }
  if (id.length > MAX_ID_LENGTH) {
    throw new ValidationError(
      {
        kind: 'invalid_run_id',
        engineId: 'validator',
        correlationId: 'validator',
        cause: { value: id.substring(0, 32) + '...', length: id.length, max: MAX_ID_LENGTH },
      },
      `runId must not exceed ${MAX_ID_LENGTH} characters; got ${id.length}`,
    );
  }
}
