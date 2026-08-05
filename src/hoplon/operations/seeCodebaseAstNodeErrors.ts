import type { SeeCodebaseErrorKind } from '../contracts/seeCodebase.js';

type AstNodeErrorKind = Extract<
  SeeCodebaseErrorKind,
  | 'UNSUPPORTED_TARGET'
  | 'PATH_NOT_FOUND'
  | 'DUPLICATE_TARGET'
  | 'AMBIGUOUS_TARGET'
  | 'UNRESOLVED_TARGET'
  | 'STALE_TARGET'
  | 'OUT_OF_SCOPE_TARGET'
>;

export class SeeCodebaseAstNodeError extends Error {
  readonly seeCodebaseKind: AstNodeErrorKind;

  constructor(kind: AstNodeErrorKind, message: string) {
    super(message);
    this.name = 'SeeCodebaseAstNodeError';
    this.seeCodebaseKind = kind;
  }
}

export function isSeeCodebaseAstNodeError(
  err: unknown,
): err is SeeCodebaseAstNodeError {
  return err instanceof SeeCodebaseAstNodeError;
}
