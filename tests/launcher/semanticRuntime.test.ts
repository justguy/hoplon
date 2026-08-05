import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { createLauncherSemanticRuntime } from '../../src/bin/semanticRuntime.js';
import { runCli } from '../../src/hoplon/launcher/cli.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');

describe('launcher semantic runtime binding', () => {
  it('threads the local native semantic runtime through the CLI status path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hoplon-launcher-semantic-'));
    try {
      const runtime = await createLauncherSemanticRuntime({
        root,
        grammarsDir: GRAMMARS_DIR,
      });
      expect(runtime).toBeDefined();
      const resolver = vi.fn(async () => runtime);
      const out: string[] = [];
      const err: string[] = [];

      const code = await runCli(
        [
          'status',
          '--root',
          root,
          '--grammars-dir',
          GRAMMARS_DIR,
          '--engine-id',
          'launcher-semantic-test',
        ],
        {
          stdout: (line) => out.push(line),
          stderr: (line) => err.push(line),
          version: '0.1.0-test',
        },
        { semanticRuntime: resolver },
      );

      expect(code).toBe(0);
      expect(err).toEqual([]);
      expect(resolver).toHaveBeenCalledOnce();
      const report = JSON.parse(out[0] ?? '{}') as {
        health?: {
          semantic?: {
            status?: string;
            capabilityClass?: string;
            runtimeProfile?: string;
            adapters?: { embedding?: string; vectorIndex?: string };
            runtimeArtifacts?: { nativeExtensionStatus?: string };
          };
        };
        extensionCapabilities?: {
          descriptor: {
            capabilityId: string;
            runtimeState: string;
            defaultBinding: string;
          };
          healthStatus?: string;
        }[];
      };

      expect(report.health?.semantic).toMatchObject({
        status: 'AVAILABLE',
        capabilityClass: 'advisory_ready',
        runtimeProfile: 'native_performance',
        adapters: {
          embedding: 'bound',
          vectorIndex: 'bound',
        },
        runtimeArtifacts: {
          nativeExtensionStatus: 'loaded',
        },
      });
      const semanticSearch = report.extensionCapabilities?.find(
        (cap) => cap.descriptor.capabilityId === 'semanticSearch',
      );
      expect(semanticSearch).toMatchObject({
        descriptor: {
          runtimeState: 'advisory_ready',
          defaultBinding: 'builtin',
        },
        healthStatus: 'available',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
