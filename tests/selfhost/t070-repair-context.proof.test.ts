/**
 * tests/selfhost/t070-repair-context.proof.test.ts — T-070 reusable failed-audit
 * repair-loop packaging proof.
 *
 * Extends the T-055 bounded rollback-template retry cycle with a packaged,
 * reusable host-facing `RepairContext` contract (t-070). The proofs below
 * demonstrate:
 *
 *   1. In-process packaging: a failed-audit session exposes a structured
 *      `RepairContext` that carries the authoritative `AuditResult`,
 *      `RollbackTemplate`, ordered session history, and explicit
 *      cross-session attempt bookkeeping — without re-summarising any of
 *      those facts. A retry session constructed with `priorRepairContext`
 *      advances its audit attemptNumber to `failedAttempt.attemptNumber + 1`
 *      and ends in `audited_pass` on a corrected, in-scope edit over the
 *      same launcher-resolved workspace.
 *
 *   2. Packaged transport extraction: the same packaging path is reachable
 *      through `createSessionTransportDispatcher`, so an external host
 *      driving Hoplon over MCP/HTTP can extract the same `RepairContext`
 *      and start a retry session that inherits the linkage — proving the
 *      contract is load-bearing on the shipped transport seam, not only in
 *      in-process helper construction.
 *
 * Scope:
 *   - uses the same stable single-symbol fixture at
 *     `src/hoplon/session/errors.ts` that T-055 exercises, so the proofs land
 *     against real audit / revert / rollback-template behavior without
 *     depending on unrelated top-level exports in the live source file.
 *   - both proofs drive `resolveLauncherWorkspace` + `runStatus` +
 *     `createDefaultHoplonEngine` to stay on the shipped launcher bootstrap
 *     path.
 *
 * Out of scope (separate slices):
 *   - retry policy, LLM prompting, escalation ownership (host-owned).
 *   - behavior verification / test execution packaging (`t-067`).
 *   - mandatory durable trace substrate on the basic repair path (`t-068`
 *     stays optional).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveLauncherWorkspace, ensureWorkspaceLayout } from '../../src/hoplon/launcher/config.js';
import { runStatus } from '../../src/hoplon/launcher/status.js';
import { createDefaultHoplonEngine } from '../../src/hoplon/engine/factory.js';
import { createHoplonEditSession } from '../../src/hoplon/session/session.js';
import { createSessionRegistry } from '../../src/hoplon/session/registry.js';
import { createSessionTransportDispatcher } from '../../src/hoplon/session/transport.js';
import {
  RepairContextSchema,
  type RepairContext,
} from '../../src/hoplon/contracts/repairContext.js';
import {
  CONTRACTED_PATH,
  seedSessionErrorFixture,
  sessionErrorSymbolsManifest,
} from './fixtures/sessionErrorFixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const GRAMMARS_DIR = path.resolve(REPO_ROOT, 'vendor/grammars');

function makeTempWorkspace(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function applyOutOfScopeEdit(baseline: string): string {
  const marker = [
    '',
    '// t-070 repair-context proof: new top-level symbol, not in contracted scope.',
    "export const T070_SENTINEL = '2026-04-20-t070';",
    '',
  ].join('\n');
  return baseline.endsWith('\n') ? `${baseline}${marker.slice(1)}` : `${baseline}${marker}`;
}

function applyCorrectedEdit(baseline: string): string {
  const marker = '\n  // t-070 retry-cycle proof: corrected edit applied inside contracted symbol.';
  return baseline.replace(
    'export class SessionError extends Error {',
    `export class SessionError extends Error {${marker}`,
  );
}

describe('T-070 — reusable failed-audit repair-context packaging', () => {
  it(
    'packages a structured RepairContext in-process and drives a linked retry to audited_pass',
    async () => {
      const root = makeTempWorkspace('hoplon-t070-inproc-');
      const baseline = seedSessionErrorFixture(root);

      try {
        const workspace = resolveLauncherWorkspace({
          root,
          grammarsDir: GRAMMARS_DIR,
          engineId: 't070-inproc-engine',
        });
        ensureWorkspaceLayout(workspace);

        const status = await runStatus({
          root,
          grammarsDir: GRAMMARS_DIR,
          engineId: 't070-inproc-engine',
        });
        expect(status.engineId).toBe('t070-inproc-engine');
        expect(status.grammarsPresent).toBe(true);

        const engine = await createDefaultHoplonEngine({
          root: workspace.root,
          dbPath: workspace.dbPath,
          gitRepoDir: workspace.gitRepoDir,
          grammarsDir: workspace.grammarsDir,
          engineId: workspace.engineId,
        });

        // ----------------------------------------------------------------
        // Session 1 — out_of_scope_symbol BLOCK, revert, extract template.
        // ----------------------------------------------------------------
        const manifest1 = sessionErrorSymbolsManifest(
          't070-inproc-s1',
          CONTRACTED_PATH,
        );
        const session1 = createHoplonEditSession({ engine, manifest: manifest1 });

        const pre1 = await session1.preflight();
        expect(pre1.status).toBe('PASS');
        const snap1 = await session1.createSnapshot();

        // Before any audit the next-attempt counter reports 1.
        expect(session1.snapshot.nextAttemptNumber).toBe(1);

        fs.writeFileSync(path.join(root, CONTRACTED_PATH), applyOutOfScopeEdit(baseline));
        session1.markEdited([CONTRACTED_PATH]);
        const audit1 = await session1.audit();
        expect(audit1.status).toBe('BLOCK');
        if (audit1.status !== 'BLOCK') throw new Error('unreachable');
        expect(session1.snapshot.nextAttemptNumber).toBe(2);

        // Asking for repair context before revert/template yields a session error,
        // not a silently-empty DTO.
        await expect(session1.getRepairContext()).rejects.toThrowError(
          /extractRollbackTemplate/,
        );

        const revert1 = await session1.revert();
        expect(revert1.reverted).toContain(CONTRACTED_PATH);
        expect(fs.readFileSync(path.join(root, CONTRACTED_PATH), 'utf8')).toBe(baseline);

        const template = await session1.extractRollbackTemplate({
          files: [CONTRACTED_PATH],
          contractedChangesMap: {
            [CONTRACTED_PATH]:
              'Only internal modifications to SessionError class body are permitted.',
          },
        });
        expect(template.snapshotRef).toBe(snap1.id);

        // ----------------------------------------------------------------
        // Repair-context packaging proof.
        // ----------------------------------------------------------------
        const repair = await session1.getRepairContext();
        const zodParsed = RepairContextSchema.safeParse(repair);
        expect(zodParsed.success).toBe(true);

        expect(repair.repairContextSchemaVersion).toBe(1);
        expect(repair.correlationId).toBe(manifest1.correlationId);
        expect(repair.projectId).toBe(manifest1.projectId);
        expect(repair.runId).toBe(manifest1.runId);
        expect(repair.failedAttempt.sessionId).toBe(session1.sessionId);
        expect(repair.failedAttempt.attemptNumber).toBe(1);
        expect(repair.failedAttempt.snapshotRef).toBe(snap1.id);
        expect(repair.failedAttempt.executionId).toBeNull(); // no traceStore injected
        expect(repair.failedAttempt.attemptId).toBeNull();
        expect(repair.nextAttempt.attemptNumber).toBe(2);
        expect(repair.nextAttempt.baselineSnapshotRef).toBe(snap1.id);

        // Authoritative AuditResult round-trip: the BLOCK violations must not be
        // summarised away. Both the out_of_scope_symbol kind and the injected
        // symbol name are present verbatim on the packaged DTO.
        expect(repair.auditResult.status).toBe('BLOCK');
        if (repair.auditResult.status !== 'BLOCK') throw new Error('unreachable');
        const repackedViolation = repair.auditResult.violations.find(
          (v) => v.kind === 'out_of_scope_symbol',
        );
        expect(repackedViolation).toBeDefined();
        if (repackedViolation?.kind !== 'out_of_scope_symbol') throw new Error('unreachable');
        expect(repackedViolation.symbolName).toBe('T070_SENTINEL');

        // RollbackTemplate preserved byte-for-byte (same snapshotRef and file entry).
        expect(repair.rollbackTemplate.snapshotRef).toBe(template.snapshotRef);
        const repackedEntry = repair.rollbackTemplate.files.find(
          (f) => f.path === CONTRACTED_PATH,
        );
        expect(repackedEntry).toBeDefined();
        expect(repackedEntry?.contractedChanges).toMatch(/SessionError class body/);
        expect(repackedEntry?.structuralSkeleton).toContain('SessionError');

        // Ordered session history preserved (no reorder, no summary).
        const expectedOps = [
          'created',
          'preflight',
          'createSnapshot',
          'markEdited',
          'audit',
          'revert',
          'extractRollbackTemplate',
        ];
        expect(repair.priorSessionHistory.map((h) => h.op)).toEqual(expectedOps);

        session1.close();

        // ----------------------------------------------------------------
        // Session 2 — retry with priorRepairContext linkage.
        // ----------------------------------------------------------------
        const manifest2 = sessionErrorSymbolsManifest(
          't070-inproc-s2',
          CONTRACTED_PATH,
        );
        const session2 = createHoplonEditSession({
          engine,
          manifest: manifest2,
          priorRepairContext: repair,
        });

        // Linkage is observable from the snapshot before any audit runs.
        expect(session2.snapshot.priorRepairContext).not.toBeNull();
        expect(session2.snapshot.priorRepairContext?.failedAttempt.sessionId).toBe(
          session1.sessionId,
        );
        expect(session2.snapshot.nextAttemptNumber).toBe(
          repair.nextAttempt.attemptNumber,
        );

        const pre2 = await session2.preflight();
        expect(pre2.status).toBe('PASS');
        const snap2 = await session2.createSnapshot();
        expect(snap2.id).not.toBe(snap1.id); // fresh snapshot over restored baseline

        const corrected = applyCorrectedEdit(baseline);
        const dry = await session2.dryRun([
          { file: CONTRACTED_PATH, content: corrected },
        ]);
        expect(dry.status).toBe('PASS');

        fs.writeFileSync(path.join(root, CONTRACTED_PATH), corrected);
        session2.markEdited([CONTRACTED_PATH]);
        const audit2 = await session2.audit();
        expect(audit2.status).toBe('PASS');
        expect(session2.state).toBe('audited_pass');

        // Attempt bookkeeping proof: the retry's first audit advanced the
        // session's internal counter to 3, since the counter was seeded from
        // the failed attempt (1) and incremented once by this session's audit.
        // The surface field `nextAttemptNumber` therefore reports 3 after
        // audit — cross-session linkage is explicit, not invented.
        expect(session2.snapshot.nextAttemptNumber).toBe(3);

        session2.close();

        // Final disk state reflects the corrected edit and nothing from the
        // failed attempt.
        const final = fs.readFileSync(path.join(root, CONTRACTED_PATH), 'utf8');
        expect(final).not.toContain('T070_SENTINEL');
        expect(final).toContain('t-070 retry-cycle proof');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    90_000,
  );

  it(
    'exposes the same RepairContext through the packaged session transport dispatcher',
    async () => {
      const root = makeTempWorkspace('hoplon-t070-transport-');
      const baseline = seedSessionErrorFixture(root);

      try {
        const workspace = resolveLauncherWorkspace({
          root,
          grammarsDir: GRAMMARS_DIR,
          engineId: 't070-transport-engine',
        });
        ensureWorkspaceLayout(workspace);

        const engine = await createDefaultHoplonEngine({
          root: workspace.root,
          dbPath: workspace.dbPath,
          gitRepoDir: workspace.gitRepoDir,
          grammarsDir: workspace.grammarsDir,
          engineId: workspace.engineId,
        });

        const registry = createSessionRegistry({ engine });
        try {
          const dispatcher = createSessionTransportDispatcher({ registry });

          // ----------------------------------------------------------------
          // Session 1 over transport — BLOCK, revert, template, repair ctx.
          // ----------------------------------------------------------------
          const manifest1 = sessionErrorSymbolsManifest(
            't070-transport-s1',
            CONTRACTED_PATH,
          );
          const start1 = await dispatcher.start({ manifest: manifest1 });
          const sessionId1 = start1.session.sessionId;

          await dispatcher.preflight({ sessionId: sessionId1 });
          await dispatcher.createSnapshot({ sessionId: sessionId1 });

          fs.writeFileSync(path.join(root, CONTRACTED_PATH), applyOutOfScopeEdit(baseline));
          await dispatcher.markEdited({
            sessionId: sessionId1,
            files: [CONTRACTED_PATH],
          });
          const auditResp = (await dispatcher.audit({ sessionId: sessionId1 })) as {
            data: { result: { status: string } };
          };
          expect(auditResp.data.result.status).toBe('BLOCK');

          await dispatcher.revert({ sessionId: sessionId1 });
          await dispatcher.extractRollbackTemplate({
            sessionId: sessionId1,
            files: [CONTRACTED_PATH],
            contractedChangesMap: {
              [CONTRACTED_PATH]:
                'Only internal modifications to SessionError class body are permitted.',
            },
          });

          const repairResp = (await dispatcher.getRepairContext({
            sessionId: sessionId1,
          })) as { data: { repairContext: unknown } };
          const parsed = RepairContextSchema.safeParse(repairResp.data.repairContext);
          expect(parsed.success).toBe(true);
          if (!parsed.success) throw new Error('unreachable');
          const repair: RepairContext = parsed.data;

          expect(repair.failedAttempt.sessionId).toBe(sessionId1);
          expect(repair.failedAttempt.attemptNumber).toBe(1);
          expect(repair.nextAttempt.attemptNumber).toBe(2);
          expect(repair.auditResult.status).toBe('BLOCK');

          await dispatcher.close({ sessionId: sessionId1 });

          // ----------------------------------------------------------------
          // Session 2 over transport — retry with priorRepairContext body.
          // ----------------------------------------------------------------
          const manifest2 = sessionErrorSymbolsManifest(
            't070-transport-s2',
            CONTRACTED_PATH,
          );
          const start2 = await dispatcher.start({
            manifest: manifest2,
            priorRepairContext: repair,
          });
          const sessionId2 = start2.session.sessionId;

          // Inspect carries the linkage + seeded attempt bookkeeping.
          const inspectResp = (await dispatcher.inspect({
            sessionId: sessionId2,
          })) as { snapshot: { priorRepairContext: RepairContext | null; nextAttemptNumber: number } };
          expect(inspectResp.snapshot.priorRepairContext?.failedAttempt.sessionId).toBe(
            sessionId1,
          );
          expect(inspectResp.snapshot.nextAttemptNumber).toBe(2);

          await dispatcher.preflight({ sessionId: sessionId2 });
          await dispatcher.createSnapshot({ sessionId: sessionId2 });

          const corrected = applyCorrectedEdit(baseline);
          fs.writeFileSync(path.join(root, CONTRACTED_PATH), corrected);
          await dispatcher.markEdited({
            sessionId: sessionId2,
            files: [CONTRACTED_PATH],
          });
          const audit2 = (await dispatcher.audit({ sessionId: sessionId2 })) as {
            data: { result: { status: string } };
            state: string;
          };
          expect(audit2.data.result.status).toBe('PASS');
          expect(audit2.state).toBe('audited_pass');

          await dispatcher.close({ sessionId: sessionId2 });
        } finally {
          registry.dispose();
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
