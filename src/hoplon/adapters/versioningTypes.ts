/** Shared value types for the VersioningAdapter contract. */

export interface GitRemoteCredentials {
  readonly username?: string;
  readonly password?: string;
}

export type VersioningSourceRefKind =
  | 'local_branch'
  | 'remote_tracking_branch';

export interface VersioningSourceRef {
  readonly kind: VersioningSourceRefKind;
  readonly name: string;
  readonly fullRef: string;
  readonly oid: string;
  readonly remote?: string;
}

export interface VersioningBranchResolution {
  readonly name: string;
  readonly fullRef: string;
  readonly oid: string;
}

export interface VersioningFileAtRef {
  readonly filepath: string;
  readonly oid: string;
}

export interface VersioningBlobAtRef {
  readonly oid: string;
  readonly bytes: Uint8Array;
}
