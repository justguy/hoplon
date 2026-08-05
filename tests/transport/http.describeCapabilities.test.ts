import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import fastifyFactory = require('fastify');

import { createHoplonHttpServer } from '../../src/hoplon/transport/http/server.js';
import type { HoplonEngine } from '../../src/hoplon/engine/types.js';

function makeEngine(): HoplonEngine {
  return {
    describeCapabilities: vi.fn().mockResolvedValue({
      catalogVersion: 1,
      engineId: 'http-cap-test',
      capabilities: [
        {
          descriptor: {
            contractSchemaVersion: 1,
            capabilityId: 'codeIntelligence',
            name: 'Code Intelligence',
            integrationPoint: 'core_adapter',
            runtimeState: 'shipped',
            defaultBinding: 'builtin',
            defaultWritePosture: 'read_only',
            sideEffectPosture: 'none',
            failureIsolation: 'core_operation',
            invocationMode: 'typed_engine_method',
            correlationFields: ['engineId', 'correlationId', 'projectId', 'runId', 'snapshotRefId'],
            versionMetadata: [
              'capability_contract_v1',
              'provider_version',
              'workspace_revision',
            ],
            dataAccess: [
              { dataClass: 'workspace_content', access: 'read_only' },
              { dataClass: 'workspace_metadata', access: 'read_only' },
            ],
            notes:
              'Tree-sitter is the shipped default. LSP- and SCIP-backed providers bind through this seam later.',
          },
          healthStatus: 'available',
        },
      ],
    }),
  } as unknown as HoplonEngine;
}

describe('POST /describeCapabilities', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await createHoplonHttpServer({
      engine: makeEngine(),
      fastify: fastifyFactory({ logger: false }),
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it('returns 200 with the capability catalog', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/describeCapabilities',
      payload: { correlationId: 'corr-http-cap-1' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      engineId: string;
      capabilities: Array<{ descriptor: { capabilityId: string } }>;
    }>();
    expect(body.engineId).toBe('http-cap-test');
    expect(body.capabilities.map((c) => c.descriptor.capabilityId)).toEqual([
      'codeIntelligence',
    ]);
  });

  it('returns 400 when correlationId is missing', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/describeCapabilities',
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });
});
