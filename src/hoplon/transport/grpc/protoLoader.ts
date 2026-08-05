/**
 * transport/grpc/protoLoader.ts — load the committed proto into a
 * `PackageDefinition` at runtime (SV1).
 *
 * Why regenerate at runtime rather than read `src/hoplon/transport/proto/generated/hoplon.proto`
 * directly? The committed artifact is the wire source of truth, but the
 * repo ships it under `src/` only. In a consumed package build (`dist/`),
 * non-TS files are not copied by `tsc`. Regenerating from the Zod-anchored
 * registry at startup keeps the runtime server self-sufficient and provably
 * equal to the committed artifact via the PG1 reproducibility test.
 *
 * The generator is deterministic (PG1 proof), so the proto text loaded here
 * is byte-identical to `src/hoplon/transport/proto/generated/hoplon.proto`.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type * as protoLoader from '@grpc/proto-loader';

import {
  HOPLON_PROTO_PACKAGE,
  HOPLON_PROTO_SERVICE,
  generateHoplonProto,
} from '../proto/generate.js';

export interface LoadedHoplonProto {
  /** Raw proto text (equal to the committed artifact). */
  readonly protoText: string;
  /** The grpc-js service definition for `HoplonService`. */
  readonly serviceDefinition: protoLoader.ServiceDefinition;
}

/**
 * Load the Hoplon proto via `@grpc/proto-loader` and return the HoplonService
 * definition ready for registration on a grpc-js server (SV1) or consumption
 * by a client (CL1).
 */
export async function loadHoplonProto(): Promise<LoadedHoplonProto> {
  const [loader] = await Promise.all([
    import('@grpc/proto-loader'),
  ]);

  const protoText = generateHoplonProto();
  const dir = mkdtempSync(join(tmpdir(), 'hoplon-grpc-'));
  const file = join(dir, 'hoplon.proto');
  writeFileSync(file, protoText, 'utf8');

  try {
    const packageDefinition = await loader.load(file, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });

    const serviceKey = `${HOPLON_PROTO_PACKAGE}.${HOPLON_PROTO_SERVICE}`;
    const raw = packageDefinition[serviceKey];
    if (!raw) {
      throw new Error(`Hoplon proto did not expose ${serviceKey} — generator drift?`);
    }
    return {
      protoText,
      serviceDefinition: raw as protoLoader.ServiceDefinition,
    };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; tmpdir cleanup is the OS's job otherwise
    }
  }
}

export { HOPLON_PROTO_PACKAGE, HOPLON_PROTO_SERVICE };
