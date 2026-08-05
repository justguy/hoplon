export class ScipIndexNotFoundError extends Error {
  readonly code = 'index_not_found';

  constructor(
    readonly indexPath: string,
    cause?: unknown,
  ) {
    super(`SCIP index not found at ${indexPath}`);
    this.name = 'ScipIndexNotFoundError';
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export class ScipIndexParseError extends Error {
  readonly code = 'invalid_index';

  constructor(
    readonly indexPath: string,
    message: string,
    cause?: unknown,
  ) {
    super(`Invalid SCIP index at ${indexPath}: ${message}`);
    this.name = 'ScipIndexParseError';
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export class ScipIndexStaleError extends Error {
  readonly code = 'stale_index';

  constructor(
    readonly indexPath: string,
    readonly expectedWorkspaceRevision: string,
    readonly actualWorkspaceRevision: string,
  ) {
    super(
      `SCIP index at ${indexPath} is stale: expected workspace revision ` +
        `${expectedWorkspaceRevision}, got ${actualWorkspaceRevision}`,
    );
    this.name = 'ScipIndexStaleError';
  }
}
