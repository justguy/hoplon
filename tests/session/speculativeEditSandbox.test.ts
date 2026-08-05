import { describe, expect, it } from 'vitest';

import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { SpeculativeEditSandboxResultSchema } from '../../src/hoplon/contracts/speculativeEditSandbox.js';
import { composeSpeculativeEditSandbox } from '../../src/hoplon/session/speculativeEditSandbox.js';
import { MANIFEST, makeMockEngine } from './helpers.js';
import type { HoplonFsAdapter } from '../../src/hoplon/adapters/fs.js';
import type { SpeculativeEditCandidate } from '../../src/hoplon/contracts/speculativeEditSandbox.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function writeText(
  fs: HoplonFsAdapter,
  path: string,
  content: string,
): Promise<void> {
  await fs.write(path, encoder.encode(content));
}

async function readText(fs: HoplonFsAdapter, path: string): Promise<string> {
  return decoder.decode(await fs.read(path));
}

describe('speculative edit sandbox', () => {
  it('evaluates two isolated candidates before adopting the first passing result', async () => {
    const activeFs = createMemFsAdapter();
    const baseline = 'export const selected = 0;\n';
    await writeText(activeFs, 'src/foo.ts', baseline);

    const candidateFs = new Map<string, HoplonFsAdapter>();
    const cleanupCalls: string[] = [];
    const candidates: readonly SpeculativeEditCandidate[] = [
      {
        candidateId: 'A',
        proposedChanges: [
          { file: 'src/foo.ts', content: 'export const selected = 1;\n' },
        ],
      },
      {
        candidateId: 'B',
        proposedChanges: [
          { file: 'src/foo.ts', content: 'export const selected = 2;\n' },
        ],
      },
    ];

    const result = await composeSpeculativeEditSandbox({
      candidates,
      activeBaseRef: 'base-1',
      correlationId: 'corr-speculative-1',
      now: () => 1_775_000_000_000,
      adoptWinner: true,
      activeSessionOptions: {
        engine: makeMockEngine(),
        manifest: MANIFEST,
        fs: activeFs,
        sessionId: 'active-adoption',
      },
      readActiveWorkspaceRef: async () => {
        expect(await readText(activeFs, 'src/foo.ts')).toBe(baseline);
        return 'base-1';
      },
      createCandidateSandbox: (candidate) => {
        const fs = createMemFsAdapter();
        candidateFs.set(candidate.candidateId, fs);
        return {
          sandboxId: `sandbox-${candidate.candidateId}`,
          transcriptRef: `trace://${candidate.candidateId}`,
          sessionOptions: {
            engine: makeMockEngine(),
            manifest: MANIFEST,
            fs,
            sessionId: `candidate-${candidate.candidateId}`,
          },
          cleanup: () => {
            cleanupCalls.push(candidate.candidateId);
          },
        };
      },
    });

    expect(SpeculativeEditSandboxResultSchema.safeParse(result).success).toBe(
      true,
    );
    expect(result.outcome).toBe('ADOPTED');
    expect(result.selectedCandidateId).toBe('A');
    expect(result.adoption.status).toBe('ADOPTED');
    expect(result.adoption.sessionId).toBe('active-adoption');
    expect(result.candidates.map((candidate) => candidate.outcome)).toEqual([
      'pass',
      'pass',
    ]);
    expect(result.candidates.map((candidate) => candidate.cleanupStatus)).toEqual([
      'CLEANED',
      'CLEANED',
    ]);
    expect(cleanupCalls).toEqual(['A', 'B']);
    expect(await readText(activeFs, 'src/foo.ts')).toBe(
      'export const selected = 1;\n',
    );
    expect(await readText(candidateFs.get('A')!, 'src/foo.ts')).toBe(
      'export const selected = 1;\n',
    );
    expect(await readText(candidateFs.get('B')!, 'src/foo.ts')).toBe(
      'export const selected = 2;\n',
    );
  });

  it('cleans up failed candidate sessions and selects the next passing candidate', async () => {
    const activeFs = createMemFsAdapter();
    const baseline = 'export const live = 0;\n';
    await writeText(activeFs, 'src/foo.ts', baseline);
    const cleanupCalls: string[] = [];

    const result = await composeSpeculativeEditSandbox({
      candidates: [
        {
          candidateId: 'A',
          proposedChanges: [{ file: 'src/foo.ts', content: 'export const a = 1;\n' }],
        },
        {
          candidateId: 'B',
          proposedChanges: [{ file: 'src/foo.ts', content: 'export const b = 2;\n' }],
        },
      ],
      activeBaseRef: 'base-1',
      correlationId: 'corr-speculative-2',
      now: () => 1_775_000_000_000,
      createCandidateSandbox: (candidate) => ({
        sandboxId: `sandbox-${candidate.candidateId}`,
        sessionOptions: {
          engine:
            candidate.candidateId === 'A'
              ? makeMockEngine({
                  auditDiff: async () => {
                    throw new Error('candidate audit failed');
                  },
                })
              : makeMockEngine(),
          manifest: MANIFEST,
          fs: createMemFsAdapter(),
          sessionId: `candidate-${candidate.candidateId}`,
        },
        cleanup: () => {
          cleanupCalls.push(candidate.candidateId);
        },
      }),
    });

    expect(result.outcome).toBe('WINNER_SELECTED');
    expect(result.selectedCandidateId).toBe('B');
    expect(result.adoption.status).toBe('NOT_REQUESTED');
    expect(result.candidates[0]?.outcome).toBe('failed');
    expect(result.candidates[0]?.phase).toBe('audit');
    expect(result.candidates[0]?.eligibleForAdoption).toBe(false);
    expect(result.candidates[0]?.cleanupStatus).toBe('CLEANED');
    expect(result.candidates[1]?.eligibleForAdoption).toBe(true);
    expect(cleanupCalls).toEqual(['A', 'B']);
    expect(await readText(activeFs, 'src/foo.ts')).toBe(baseline);
  });

  it('does not select a passing candidate whose sandbox cleanup failed', async () => {
    const result = await composeSpeculativeEditSandbox({
      candidates: [
        {
          candidateId: 'A',
          proposedChanges: [{ file: 'src/foo.ts', content: 'export const a = 1;\n' }],
        },
        {
          candidateId: 'B',
          proposedChanges: [{ file: 'src/foo.ts', content: 'export const b = 2;\n' }],
        },
      ],
      activeBaseRef: 'base-1',
      correlationId: 'corr-speculative-3',
      now: () => 1_775_000_000_000,
      createCandidateSandbox: (candidate) => ({
        sandboxId: `sandbox-${candidate.candidateId}`,
        sessionOptions: {
          engine: makeMockEngine(),
          manifest: MANIFEST,
          fs: createMemFsAdapter(),
          sessionId: `candidate-${candidate.candidateId}`,
        },
        cleanup:
          candidate.candidateId === 'A'
            ? () => {
                throw new Error('cleanup failed');
              }
            : undefined,
      }),
    });

    expect(result.outcome).toBe('WINNER_SELECTED');
    expect(result.selectedCandidateId).toBe('B');
    expect(result.candidates[0]?.outcome).toBe('pass');
    expect(result.candidates[0]?.cleanupStatus).toBe('FAILED');
    expect(result.candidates[0]?.eligibleForAdoption).toBe(false);
    expect(result.candidates[1]?.eligibleForAdoption).toBe(true);
  });

  it('refuses active adoption when the active workspace changed after speculation began', async () => {
    const activeFs = createMemFsAdapter();
    await writeText(activeFs, 'src/foo.ts', 'export const live = 0;\n');

    const result = await composeSpeculativeEditSandbox({
      candidates: [
        {
          candidateId: 'A',
          proposedChanges: [{ file: 'src/foo.ts', content: 'export const live = 1;\n' }],
        },
      ],
      activeBaseRef: 'base-1',
      correlationId: 'corr-speculative-4',
      now: () => 1_775_000_000_000,
      adoptWinner: true,
      activeSessionOptions: {
        engine: makeMockEngine(),
        manifest: MANIFEST,
        fs: activeFs,
        sessionId: 'active-adoption',
      },
      readActiveWorkspaceRef: async () => {
        await writeText(activeFs, 'src/foo.ts', '// foreign edit\n');
        return 'base-2';
      },
      createCandidateSandbox: (candidate) => ({
        sandboxId: `sandbox-${candidate.candidateId}`,
        sessionOptions: {
          engine: makeMockEngine(),
          manifest: MANIFEST,
          fs: createMemFsAdapter(),
          sessionId: `candidate-${candidate.candidateId}`,
        },
        cleanup: () => undefined,
      }),
    });

    expect(result.outcome).toBe('ADOPTION_CONFLICT');
    expect(result.selectedCandidateId).toBe('A');
    expect(result.adoption.status).toBe('CONFLICT');
    expect(result.adoption.activeRefAtAdoption).toBe('base-2');
    expect(result.adoption.sessionId).toBeNull();
    expect(await readText(activeFs, 'src/foo.ts')).toBe('// foreign edit\n');
  });

  it('packages active-ref reader failures as adoption failures', async () => {
    const result = await composeSpeculativeEditSandbox({
      candidates: [
        {
          candidateId: 'A',
          proposedChanges: [{ file: 'src/foo.ts', content: 'export const live = 1;\n' }],
        },
      ],
      activeBaseRef: 'base-1',
      correlationId: 'corr-speculative-5',
      now: () => 1_775_000_000_000,
      adoptWinner: true,
      activeSessionOptions: {
        engine: makeMockEngine(),
        manifest: MANIFEST,
        fs: createMemFsAdapter(),
        sessionId: 'active-adoption',
      },
      readActiveWorkspaceRef: () => {
        throw new Error('active ref unavailable');
      },
      createCandidateSandbox: (candidate) => ({
        sandboxId: `sandbox-${candidate.candidateId}`,
        sessionOptions: {
          engine: makeMockEngine(),
          manifest: MANIFEST,
          fs: createMemFsAdapter(),
          sessionId: `candidate-${candidate.candidateId}`,
        },
      }),
    });

    expect(result.outcome).toBe('ADOPTION_FAILED');
    expect(result.adoption.status).toBe('FAILED');
    expect(result.adoption.phase).toBe('activeRef');
    expect(result.adoption.sessionId).toBeNull();
  });
});
