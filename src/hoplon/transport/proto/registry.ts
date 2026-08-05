/** Shared operation registry for generated proto and runtime transports. */

import { CORE_PROTO_OPERATIONS } from './registryCoreOperations.js';
import { EXTENDED_PROTO_OPERATIONS } from './registryExtendedOperations.js';
import type { ProtoOperation } from './registryTypes.js';

export type { ProtoOperation, ProtoStreamingKind } from './registryTypes.js';

export const HOPLON_PROTO_OPERATIONS: readonly ProtoOperation[] = [
  ...CORE_PROTO_OPERATIONS,
  ...EXTENDED_PROTO_OPERATIONS,
];
