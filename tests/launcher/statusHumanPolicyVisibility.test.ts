/**
 * tests/launcher/statusHumanPolicyVisibility.test.ts — t-086 proof
 * that `renderStatusHuman` surfaces folder-policy summary + engagement
 * state per registered project without leaking content-bearing fields.
 */
import { describe, it, expect } from 'vitest';

import { renderStatusHuman } from '../../src/hoplon/launcher/statusHuman.js';
import type { LauncherStatusReport } from '../../src/hoplon/launcher/status.js';

function baseReport(): LauncherStatusReport {
  return {
    version: 1,
    workspace: {
      root: '/tmp/launcher-root',
      dbPath: '/tmp/launcher-root/.hoplon/hoplon.db',
      gitRepoDir: '/tmp/launcher-root/.hoplon/repo',
      grammarsDir: '/tmp/launcher-root/vendor/grammars',
      engineId: 'local-0',
    },
    engineId: 'local-0',
    health: {
      engineId: 'local-0',
      uptimeMs: 0,
      adapters: { fs: 'ok' },
    } as LauncherStatusReport['health'],
    grammarsPresent: true,
    capabilities: [{ name: 'fs', status: 'available' }],
    extensionCapabilities: [],
    surfaces: { mcp: 'available', http: 'available' },
    liveUsageBundle: {
      name: 'hoplon-live-usage-bundle',
      hoplonSurfaces: {
        launcherCommands: ['hoplon status', 'hoplon mcp serve', 'hoplon http serve'],
        queryCommands: [
          'hoplon query capabilities',
          'hoplon query skeleton',
          'hoplon query structure',
          'hoplon query search',
          'hoplon query project',
          'hoplon query see',
        ],
        editSessionEntry: 'createHoplonEditSession',
      },
      rawTextCompanion: {
        owner: 'host',
        coverage: ['docs', 'configs', 'env files', 'logs', 'binary content', 'launcher unavailable'],
      },
    },
    liveUseDefaults: {
      adoptedPath: 'p',
      defaults: {
        agentRead: 'a',
        agentSearch: 'b',
        supervisedEdit: 'c',
      },
      fallbacks: [],
      codeReadReplacement: {
        scope: 's',
        authoritativeSurface: 'a',
        transports: ['t'],
        codePrimitives: ['c'],
        hostCompanionLoadBearing: false,
        outOfScope: [],
      },
      unsupported: [],
      strictAgentFallback: {
        mode: 'fail_closed',
        launcherUnavailable: {
          kind: 'strict_agent_launcher_unavailable',
          agentFallbackAllowed: false,
        },
        unsupportedSurface: {
          kind: 'strict_agent_unsupported_route',
          agentFallbackAllowed: false,
        },
        forbiddenFallbacks: [],
      },
      operatingModel: {
        model: 'single-execution-surface',
        v2TwoLayer: 'deferred',
        pendingOn: ['t-068'],
      },
    } as unknown as LauncherStatusReport['liveUseDefaults'],
    safeEdit: {
      entry: 'createHoplonEditSession.applyEdits',
      contentMode: 'utf8_text_only',
      transportMode: 'bounded_json_requests',
      stagingMode: 'session_scoped_base64_chunks',
      writeVariants: { fullFile: 'available', patch: 'available', structural: 'available' },
      requirements: { fsAdapter: 'required', codeIntelligenceForStructural: 'required' },
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
        maxFileBytes: 1,
        parseTimeoutMs: 1,
        structuralHardCeilingBytes: 1,
        chunkedUploadMaxChunkBytes: 1,
        chunkedUploadMaxTotalBytes: 1,
        chunkedUploadMaxEntriesPerSession: 1,
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
    },
    projects: {
      launcherRoot: '/tmp/launcher-root',
      storePath: '/tmp/launcher-root/.hoplon/projects.json',
      active: null,
      registered: [
        {
          projectId: 'p1',
          label: 'p1',
          fsRoot: '/tmp/p1',
          dbPath: '/tmp/p1/.hoplon/hoplon.db',
          gitRepoDir: '/tmp/p1/.hoplon/repo',
          grammarsDir: '/tmp/p1/vendor/grammars',
          engineId: 'local-p1',
          registeredAtIso: '2026-04-23T00:00:00.000Z',
          policy: {
            revertAllowlistCount: 0,
            secretPatternsCount: 0,
            folderPolicy: {
              defaultAccess: 'read_only',
              folderRuleCount: 3,
              principalCount: 1,
              engagementTokenTtlMs: 60_000,
            },
          },
          engagementState: {
            active: 2,
            activeReadOnly: 1,
            activeReadWrite: 1,
            expiredOrMalformed: 1,
            soonestExpiryIso: '2026-04-23T01:30:00.000Z',
          },
        },
      ],
    },
  } as unknown as LauncherStatusReport;
}

describe('renderStatusHuman policy + engagement visibility (t-086)', () => {
  it('renders the folder-policy summary line under each registered project', () => {
    const out = renderStatusHuman(baseReport());
    expect(out).toContain(
      'folder policy (t-082): defaultAccess=read_only, folderRules=3, principals=1, engagementTokenTtlMs=60000',
    );
  });

  it('renders the engagement-state line with active counts and soonest expiry', () => {
    const out = renderStatusHuman(baseReport());
    expect(out).toContain(
      'engagement state (t-086): active=2 (read_only=1, read_write=1), expiredOrMalformed=1, soonestExpiry=2026-04-23T01:30:00.000Z',
    );
  });

  it('omits content-bearing fields (folder paths, token bytes, principal labels) from the human output', () => {
    const out = renderStatusHuman(baseReport());
    // The report shape never carries token bytes / nonces / principal
    // values — only counts and a single soonest-expiry timestamp. Sniff
    // for the *value* shapes that would indicate a leak, not for field
    // names like `engagementTokenTtlMs` which carry only a number.
    expect(out).not.toMatch(/nonce[:= ]/i);
    expect(out).not.toMatch(/principal-secret|principal_label/i);
    expect(out).not.toMatch(/TOKEN-[A-Z0-9]+/);
    expect(out).not.toContain('"folder"');
  });

  it('reports soonestExpiry=none when no active bindings exist', () => {
    const report = baseReport();
    report.projects.registered[0]!.engagementState = {
      active: 0,
      activeReadOnly: 0,
      activeReadWrite: 0,
      expiredOrMalformed: 0,
      soonestExpiryIso: null,
    };
    const out = renderStatusHuman(report);
    expect(out).toContain('soonestExpiry=none');
  });
});
