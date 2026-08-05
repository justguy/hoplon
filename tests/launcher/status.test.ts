/**
 * tests/launcher/status.test.ts — `runStatus` integration test.
 *
 * Proves the launcher can construct a real engine against a temp workspace,
 * probe its health, and report both current adapter truth and the T-046
 * extension-capability catalog honestly.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runStatus } from '../../src/hoplon/launcher/status.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor/grammars');

function makeTempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hoplon-launcher-status-'));
}

describe('runStatus', () => {
  it('reports an honest status envelope for a fresh workspace', async () => {
    const root = makeTempWorkspace();
    try {
      const report = await runStatus({
        root,
        grammarsDir: GRAMMARS_DIR,
        engineId: 'launcher-test-0',
      });

      expect(report.version).toBe(1);
      expect(report.engineId).toBe('launcher-test-0');
      expect(report.workspace.root).toBe(path.resolve(root));
      expect(report.workspace.dbPath.startsWith(path.resolve(root))).toBe(true);
      expect(report.workspace.grammarsDir).toBe(GRAMMARS_DIR);
      expect(report.grammarsPresent).toBe(true);

      const names = new Set(report.capabilities.map((c) => c.name));
      for (const expected of [
        'fs',
        'versioning',
        'snapshotStore',
        'lockProvider',
        'emitter',
        'codeIntelligence',
        'secretScanner',
        'staticAnalysis',
      ]) {
        expect(names, `missing capability: ${expected}`).toContain(expected);
      }

      for (const cap of report.capabilities) {
        expect(cap.status).toBe('available');
      }

      expect(report.extensionCapabilities.map((c) => c.descriptor.capabilityId)).toEqual([
        'codeIntelligence',
        'secretScanner',
        'staticAnalysis',
        'summarizer',
        'embedding',
        'vectorStore',
        'semanticSearch',
        'anomalyDetector',
        'violationPredictor',
        'dlp',
        'blastRadius',
        'versionSyncedIntelligence',
        'semanticGapAnalysis',
        'semanticTwins',
        'mutationTesting',
        'complianceExports',
      ]);
      expect(report.extensionCapabilities[0]?.descriptor.runtimeState).toBe('shipped');
      expect(report.extensionCapabilities[0]?.healthStatus).toBe('available');
      expect(report.extensionCapabilities[2]?.descriptor.runtimeState).toBe('seam_only');
      expect(report.extensionCapabilities[2]?.descriptor.defaultBinding).toBe('noop');
      expect(report.extensionCapabilities[3]?.descriptor.runtimeState).toBe('seam_only');
      expect(report.extensionCapabilities[3]?.healthStatus).toBeUndefined();
      // t-034: the semantic-search composite consumer at index 6 is seam_only
      // while the launcher uses the default (noop) embedding + vectorStore pair.
      expect(report.extensionCapabilities[6]?.descriptor.capabilityId).toBe('semanticSearch');
      expect(report.extensionCapabilities[6]?.descriptor.runtimeState).toBe('seam_only');
      expect(report.extensionCapabilities[6]?.descriptor.defaultBinding).toBe('noop');
      expect(report.extensionCapabilities[6]?.descriptor.invocationMode).toBe('typed_engine_method');
      expect(report.extensionCapabilities[6]?.descriptor.failureIsolation).toBe('advisory_only');
      // t-037: anomaly detector is a typed engine seam with advisory-only isolation.
      expect(report.extensionCapabilities[7]?.descriptor.capabilityId).toBe('anomalyDetector');
      expect(report.extensionCapabilities[7]?.descriptor.invocationMode).toBe('typed_engine_method');
      expect(report.extensionCapabilities[7]?.descriptor.failureIsolation).toBe('advisory_only');
      // t-026: DLP seam at index 9, advisory-only warning-only posture.
      expect(report.extensionCapabilities[9]?.descriptor.capabilityId).toBe('dlp');
      expect(report.extensionCapabilities[9]?.descriptor.runtimeState).toBe('seam_only');
      expect(report.extensionCapabilities[9]?.descriptor.defaultBinding).toBe('noop');
      expect(report.extensionCapabilities[9]?.descriptor.sideEffectPosture).toBe('warning_only');
      expect(report.extensionCapabilities[9]?.descriptor.failureIsolation).toBe('advisory_only');
      expect(
        report.extensionCapabilities.every(
          (c) =>
            c.descriptor.correlationFields.includes('engineId') &&
            c.descriptor.correlationFields.includes('correlationId'),
        ),
      ).toBe(true);

      expect(report.surfaces).toEqual({ mcp: 'available', http: 'available' });
      expect(report.health.engineId).toBe('launcher-test-0');
      expect(typeof report.health.uptimeMs).toBe('number');

      // t-057 — the Live Usage Bundle handshake names the supported
      // "use Hoplon now" stack. Hoplon-owned surfaces must match what is
      // materially shipped (launcher + query + session); the raw-text
      // companion must stay host-owned.
      expect(report.liveUsageBundle.name).toBe('hoplon-live-usage-bundle');
      expect(report.liveUsageBundle.hoplonSurfaces.launcherCommands).toEqual([
        'hoplon status',
        'hoplon mcp serve',
        'hoplon http serve',
      ]);
      expect(report.liveUsageBundle.hoplonSurfaces.queryCommands).toEqual([
        'hoplon query capabilities',
        'hoplon query skeleton',
        'hoplon query structure',
        'hoplon query search',
        'hoplon query project',
        'hoplon query see',
      ]);
      expect(report.liveUsageBundle.hoplonSurfaces.editSessionEntry).toBe(
        'createHoplonEditSession',
      );
      expect(report.liveUsageBundle.rawTextCompanion.owner).toBe('host');
      expect(report.liveUsageBundle.rawTextCompanion.coverage).toEqual([
        'docs',
        'configs',
        'env files',
        'logs',
        'binary content',
        'launcher unavailable',
      ]);

      // t-065 — default-adoption truth handshake. Names the defaults on the
      // bundle path, the explicit host-owned fallbacks, the unsupported
      // categories tracked as separate work, and the deferred V2 stance.
      expect(report.liveUseDefaults.adoptedPath).toBe('hoplon-live-usage-bundle');
      expect(report.liveUseDefaults.defaults).toEqual({
        agentRead: 'engine.seeCodebase',
        agentSearch: 'engine.seeCodebase',
        supervisedEdit: 'createHoplonEditSession.applyEdits',
      });
      expect(report.liveUseDefaults.fallbacks.map((f) => f.category)).toEqual([
        'raw_file_read',
        'raw_text_search',
        'structural_js_ts_read',
        'host_owned_editor_write',
      ]);
      // t-075: fallback entries now carry an explicit scope that narrows
      // where the host raw companion is still load-bearing. Raw file
      // read/search explicitly do NOT cover supported non-binary code
      // work after this slice.
      expect(report.liveUseDefaults.fallbacks.map((f) => f.scope)).toEqual([
        'non_code_repo_text_or_launcher_unavailable',
        'non_code_repo_text_or_launcher_unavailable',
        'structural_small_file_ergonomics',
        'host_owned_editor',
      ]);
      for (const fb of report.liveUseDefaults.fallbacks) {
        expect(fb.owner).toBe('host');
        expect(fb.primitive.length).toBeGreaterThan(0);
        expect(fb.reason.length).toBeGreaterThan(0);
        expect(fb.scope.length).toBeGreaterThan(0);
      }

      // t-075: code-only replacement boundary names engine.seeCodebase as
      // the single authoritative packaged surface on the supported
      // non-binary code boundary, keeps non-code repo text out of scope,
      // and declares the host companion is no longer load-bearing for
      // supported code work.
      const boundary = report.liveUseDefaults.codeReadReplacement;
      expect(boundary.scope).toBe('supported_non_binary_code');
      expect(boundary.authoritativeSurface).toBe('engine.seeCodebase');
      expect(boundary.hostCompanionLoadBearing).toBe(false);
      expect(boundary.transports).toEqual([
        'engine.seeCodebase (in-process)',
        'see_codebase (MCP)',
        'hoplon query see (CLI)',
        'POST /seeCodebase (HTTP)',
      ]);
      expect(boundary.codePrimitives).toEqual([
        'rawFileRead',
        'rawTextSearch',
        'packContext',
        'searchSymbols',
        'extractStructuralTemplate',
      ]);
      expect(boundary.inScope.length).toBeGreaterThan(0);
      expect(boundary.outOfScope.map((o) => o.category)).toEqual([
        'non_code_repo_text_docs',
        'non_code_repo_text_configs',
        'non_code_repo_text_env_and_logs',
        'binary_files',
      ]);
      for (const oos of boundary.outOfScope) {
        expect(oos.stillOwnedBy).toBe('host_raw_companion');
        expect(oos.reason.length).toBeGreaterThan(0);
      }
      const unsupportedTrack = report.liveUseDefaults.unsupported.map(
        (u) => u.trackedAs,
      );
      expect(unsupportedTrack).toEqual([
        't-066',
        't-067',
        't-068',
        'out-of-scope-for-t-065',
      ]);
      expect(report.liveUseDefaults.strictAgentFallback).toMatchObject({
        mode: 'fail_closed',
        launcherUnavailable: {
          kind: 'strict_agent_launcher_unavailable',
          agentFallbackAllowed: false,
        },
        unsupportedSurface: {
          agentFallbackAllowed: false,
        },
      });
      expect(
        report.liveUseDefaults.strictAgentFallback.forbiddenFallbacks,
      ).toEqual([
        'cat',
        'rg',
        'grep',
        'filesystem_mcp',
        'ide_viewer',
        'host_write_flow',
        'markEdited',
      ]);
      expect(report.liveUseDefaults.operatingModel.model).toBe(
        'single-execution-surface',
      );
      expect(report.liveUseDefaults.operatingModel.v2TwoLayer).toBe('deferred');
      expect(report.liveUseDefaults.operatingModel.pendingOn).toEqual(['t-068']);
      expect(
        report.liveUseDefaults.operatingModel.deferredBecause.length,
      ).toBeGreaterThan(0);

      expect(report.safeEdit).toEqual({
        entry: 'createHoplonEditSession.applyEdits',
        contentMode: 'utf8_text_only',
        transportMode: 'bounded_json_requests',
        stagingMode: 'session_scoped_base64_chunks',
        writeVariants: {
          fullFile: 'available',
          patch: 'available',
          structural: 'available',
        },
        requirements: {
          fsAdapter: 'required',
          codeIntelligenceForStructural: 'required',
        },
        lockTopology: {
          providerInjection: 'launcher_shared_in_process_by_default',
          omittedProviderBehavior: 'lock_free_degraded',
          lockUniverseScope: 'per_lock_provider_instance',
          crossLauncherSerialization:
            'not_guaranteed_without_shared_distributed_provider',
          distributedProviderSupport: 'available_when_host_binds_shared_provider',
          protects: [
            'ast_node_overlap',
            'same_file_structural_commit',
            'same_file_textual_write',
          ],
          doesNotProtect: [
            'semantic_dependencies',
            'imports',
            'dto_field_coupling',
            'routes',
            'shared_contracts',
            'os_level_writes',
          ],
        },
        limits: {
          maxFileBytes: 524288,
          parseTimeoutMs: 5000,
          structuralHardCeilingBytes: 10 * 1024 * 1024,
          chunkedUploadMaxChunkBytes: 5 * 1024 * 1024,
          chunkedUploadMaxTotalBytes: 64 * 1024 * 1024,
          chunkedUploadMaxEntriesPerSession: 64,
        },
        unsupported: {
          binaryFiles: false,
          chunkedUpload: true,
          streamingUpload: false,
          nodeScopedLocks: true,
        },
        structuralScope: {
          targeting: 'top_level_symbol_or_symbol_path',
          supportedLanguages: ['javascript', 'typescript', 'tsx'],
        },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
