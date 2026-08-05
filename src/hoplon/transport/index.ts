/**
 * transport/index.ts — barrel re-export for Phase 3 transport contracts.
 *
 * Public surface: HoplonEngineTransport interface, TransportError class,
 * serializeRequest/deserializeResponse helpers, TransportErrorKind type,
 * T3 NDJSON streaming helpers, and T4 auth middleware hooks.
 */

export {
  TransportError,
  serializeRequest,
  deserializeResponse,
} from './types.js';

export type {
  TransportErrorKind,
  TransportErrorOptions,
  HoplonEngineTransport,
} from './types.js';

// T3 — NDJSON streaming for large packContext responses
export {
  NDJSON_STREAM_THRESHOLD_BYTES,
  streamPackedContextNdjson,
  parseNdjsonStream,
  streamOrJsonPackedContext,
} from './http/streaming.js';

export type {
  NdjsonFrame,
  MetadataFrameValue,
} from './http/streaming.js';

// T1 — HTTP server
export {
  createHoplonHttpServer,
} from './http/server.js';

export type {
  HoplonHttpServerOptions,
} from './http/server.js';

// T-024 — gRPC server/client transport
export {
  createHoplonGrpcServer,
} from './grpc/server.js';

export type {
  HoplonGrpcServerOptions,
  HoplonGrpcServer,
} from './grpc/server.js';

export {
  createRemoteHoplonGrpcEngine,
} from './grpc/client.js';

export type {
  RemoteHoplonGrpcEngineOptions,
  RemoteHoplonGrpcEngine,
} from './grpc/client.js';

// T2 — Remote HTTP client
export {
  createRemoteHoplonEngine,
} from './http/client.js';
export {
  createRemoteHoplonSessionClient,
} from './http/sessionClient.js';

export type {
  RemoteHoplonEngineOptions,
} from './http/client.js';
export type {
  RemoteHoplonSessionClient,
  RemoteHoplonSessionClientOptions,
} from './http/sessionClient.js';

// T4 — Auth middleware hooks
export {
  createNoopAuthMiddleware,
  createBearerTokenAuthMiddleware,
  createAuthRegistry,
} from './http/auth.js';

export type {
  AuthRequest,
  AuthContext,
  AuthMiddleware,
  AuthRegistry,
  BearerTokenAuthOptions,
} from './http/auth.js';

// T-024 sub-slice A — transport-agnostic engine dispatcher
export { createEngineDispatcher } from './dispatcher.js';

export type {
  EngineDispatcher,
  DispatchRequest,
  DispatchCallShape,
} from './dispatcher.js';

// t-080 — multi-project routing on top of the single-project dispatcher
export { createProjectAwareDispatcher } from './projectResolver.js';
export type {
  ProjectAwareDispatcher,
  ProjectAwareDispatcherOptions,
} from './projectResolver.js';

// t-095 — opt-in strict agent-facing tool/route profile
export {
  DEFAULT_AGENT_TOOL_PROFILE,
  STRICT_AGENT_TOOL_PROFILE,
  parseAgentToolProfileFlag,
} from './agentToolProfile.js';

export type {
  AgentToolProfile,
  HttpProjectOp,
  HttpSessionOp,
} from './agentToolProfile.js';
