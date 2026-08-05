/**
 * transport/proto/index.ts — GRPC-PG1 proto surface re-export.
 *
 * Exposes the registry, the generator, and metadata constants. PG1 does
 * not export any runtime gRPC client or server — those are later waves.
 */

export {
  HOPLON_PROTO_OPERATIONS,
} from './registry.js';
export type {
  ProtoOperation,
  ProtoStreamingKind,
} from './registry.js';

export {
  generateHoplonProto,
  HOPLON_PROTO_ARTIFACT_PATH,
  HOPLON_PROTO_PACKAGE,
  HOPLON_PROTO_SERVICE,
} from './generate.js';
