/**
 * launcher/statusHuman.ts — human-readable renderer for `hoplon status`.
 *
 * Split from cli.ts so the dispatcher file stays under the 300-line
 * architecture cap. The JSON status envelope remains the canonical
 * machine-readable output.
 */

import type { LauncherStatusReport } from './status.js';

export function renderStatusHuman(report: LauncherStatusReport): string {
  const lines: string[] = [];
  lines.push(`Hoplon workspace: ${report.workspace.root}`);
  lines.push(`  engineId:     ${report.engineId}`);
  lines.push(`  db:           ${report.workspace.dbPath}`);
  lines.push(`  git repo:     ${report.workspace.gitRepoDir}`);
  lines.push(
    `  grammars:     ${report.workspace.grammarsDir} (${report.grammarsPresent ? 'present' : 'missing'})`,
  );
  lines.push(`Adapters:`);
  for (const cap of report.capabilities) {
    lines.push(
      `  ${cap.status === 'available' ? '✓' : cap.status === 'degraded' ? '~' : '✗'} ${cap.name.padEnd(18)} ${cap.status}`,
    );
  }
  lines.push(`Extension contracts:`);
  for (const cap of report.extensionCapabilities) {
    const state = cap.descriptor.runtimeState;
    const marker = state === 'shipped' ? '✓' : state === 'seam_only' ? '•' : '○';
    const suffix = cap.healthStatus ? ` (${cap.healthStatus})` : '';
    lines.push(`  ${marker} ${cap.descriptor.capabilityId.padEnd(28)} ${state}${suffix}`);
  }
  lines.push(`Packaged surfaces:`);
  lines.push(`  ✓ mcp (stdio, sse)`);
  lines.push(`  ✓ http`);
  lines.push(`Live usage bundle:`);
  lines.push(`  name: ${report.liveUsageBundle.name}`);
  lines.push(
    `  launcher: ${report.liveUsageBundle.hoplonSurfaces.launcherCommands.join(', ')}`,
  );
  lines.push(
    `  query: ${report.liveUsageBundle.hoplonSurfaces.queryCommands.join(', ')}`,
  );
  lines.push(
    `  edit loop: ${report.liveUsageBundle.hoplonSurfaces.editSessionEntry}`,
  );
  lines.push(
    `  raw-text companion: ${report.liveUsageBundle.rawTextCompanion.owner}-owned (${report.liveUsageBundle.rawTextCompanion.coverage.join(', ')})`,
  );
  lines.push(`Live-use defaults (t-065):`);
  lines.push(`  adopted path: ${report.liveUseDefaults.adoptedPath}`);
  lines.push(`  default agent read:    ${report.liveUseDefaults.defaults.agentRead}`);
  lines.push(`  default agent search:  ${report.liveUseDefaults.defaults.agentSearch}`);
  lines.push(`  default supervised edit: ${report.liveUseDefaults.defaults.supervisedEdit}`);
  lines.push(`  fallbacks (host-owned):`);
  for (const fb of report.liveUseDefaults.fallbacks) {
    lines.push(`    • ${fb.category} [${fb.scope}]: ${fb.primitive}`);
  }
  lines.push(`  code-read replacement boundary (t-075):`);
  lines.push(
    `    scope: ${report.liveUseDefaults.codeReadReplacement.scope}`,
  );
  lines.push(
    `    authoritative surface: ${report.liveUseDefaults.codeReadReplacement.authoritativeSurface}`,
  );
  lines.push(
    `    transports: ${report.liveUseDefaults.codeReadReplacement.transports.join(', ')}`,
  );
  lines.push(
    `    code primitives: ${report.liveUseDefaults.codeReadReplacement.codePrimitives.join(', ')}`,
  );
  lines.push(
    `    host companion load-bearing on code boundary: ${report.liveUseDefaults.codeReadReplacement.hostCompanionLoadBearing}`,
  );
  lines.push(`    out of scope (still host-owned):`);
  for (const oos of report.liveUseDefaults.codeReadReplacement.outOfScope) {
    lines.push(`      ○ ${oos.category}`);
  }
  lines.push(`  unsupported (tracked separately):`);
  for (const u of report.liveUseDefaults.unsupported) {
    lines.push(`    ○ ${u.category} → ${u.trackedAs}`);
  }
  lines.push(`  strict-agent fallback policy (t-097):`);
  lines.push(
    `    mode: ${report.liveUseDefaults.strictAgentFallback.mode}`,
  );
  lines.push(
    `    launcher unavailable: ${report.liveUseDefaults.strictAgentFallback.launcherUnavailable.kind}`,
  );
  lines.push(
    `    unsupported surface: ${report.liveUseDefaults.strictAgentFallback.unsupportedSurface.kind}`,
  );
  lines.push(
    `    agent fallback allowed: ${report.liveUseDefaults.strictAgentFallback.launcherUnavailable.agentFallbackAllowed}`,
  );
  lines.push(
    `  operating model: ${report.liveUseDefaults.operatingModel.model} (V2 two-layer: ${report.liveUseDefaults.operatingModel.v2TwoLayer}, pending on ${report.liveUseDefaults.operatingModel.pendingOn.join(', ')})`,
  );
  lines.push(`Safe-edit limits:`);
  lines.push(`  entry: ${report.safeEdit.entry}`);
  lines.push(`  content mode: ${report.safeEdit.contentMode}`);
  lines.push(
    `  transport: ${report.safeEdit.transportMode}; staging=${report.safeEdit.stagingMode}`,
  );
  lines.push(
    `  write variants: full_file=${report.safeEdit.writeVariants.fullFile}, patch=${report.safeEdit.writeVariants.patch}, structural=${report.safeEdit.writeVariants.structural}`,
  );
  lines.push(
    `  locks: provider=${report.safeEdit.lockTopology.providerInjection}, omitted=${report.safeEdit.lockTopology.omittedProviderBehavior}`,
  );
  lines.push(
    `  lock universe: ${report.safeEdit.lockTopology.lockUniverseScope}; cross-launcher serialization=${report.safeEdit.lockTopology.crossLauncherSerialization}`,
  );
  lines.push(
    `  locks do not protect: ${report.safeEdit.lockTopology.doesNotProtect.join(', ')}`,
  );
  lines.push(
    `  limits: maxFileBytes=${report.safeEdit.limits.maxFileBytes}, parseTimeoutMs=${report.safeEdit.limits.parseTimeoutMs}, structuralHardCeilingBytes=${report.safeEdit.limits.structuralHardCeilingBytes}`,
  );
  lines.push(
    `  chunked upload limits: maxChunkBytes=${report.safeEdit.limits.chunkedUploadMaxChunkBytes}, maxTotalBytes=${report.safeEdit.limits.chunkedUploadMaxTotalBytes}, maxEntriesPerSession=${report.safeEdit.limits.chunkedUploadMaxEntriesPerSession}`,
  );
  lines.push(
    `  unsupported: binaryFiles=${report.safeEdit.unsupported.binaryFiles}, chunkedUpload=${report.safeEdit.unsupported.chunkedUpload}, streamingUpload=${report.safeEdit.unsupported.streamingUpload}, nodeScopedLocks=${report.safeEdit.unsupported.nodeScopedLocks}`,
  );
  lines.push(`Projects (t-080 multi-project registration):`);
  lines.push(`  store: ${report.projects.storePath}`);
  lines.push(
    `  active: ${report.projects.active ? `${report.projects.active.projectId} (${report.projects.active.fsRoot})` : 'none'}`,
  );
  lines.push(`  registered (${report.projects.registered.length}):`);
  if (report.projects.registered.length === 0) {
    lines.push('    (none — use `hoplon project register --project-id <id> --fs-root <dir>`)');
  } else {
    for (const p of report.projects.registered) {
      const activeMarker =
        report.projects.active && report.projects.active.projectId === p.projectId
          ? ' [active]'
          : '';
      lines.push(
        `    • ${p.projectId}${activeMarker} → ${p.fsRoot} (engineId=${p.engineId}, policy={revertAllowlist=${p.policy.revertAllowlistCount}, secretPatterns=${p.policy.secretPatternsCount}})`,
      );
      if (p.policy.folderPolicy) {
        const fp = p.policy.folderPolicy;
        lines.push(
          `        folder policy (t-082): defaultAccess=${fp.defaultAccess}, folderRules=${fp.folderRuleCount}, principals=${fp.principalCount}, engagementTokenTtlMs=${fp.engagementTokenTtlMs}`,
        );
      }
      const es = p.engagementState;
      const expiry = es.soonestExpiryIso ?? 'none';
      lines.push(
        `        engagement state (t-086): active=${es.active} (read_only=${es.activeReadOnly}, read_write=${es.activeReadWrite}), expiredOrMalformed=${es.expiredOrMalformed}, soonestExpiry=${expiry}`,
      );
    }
  }
  return lines.join('\n');
}
