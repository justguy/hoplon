/**
 * operations/seeCodebaseIntelligence.ts — AIC-2 advisory read sidecars.
 *
 * Builds metadata from already-produced seeCodebase results. It does not read
 * files, change routing, or introduce a strict-mode fallback path.
 */

import type {
  AdvisoryIntelligenceProviderState,
  AdvisoryIntelligenceSidecarEnvelope,
} from '../contracts/advisoryIntelligence.js';
import { createAdvisoryEvidenceState } from '../contracts/advisoryIntelligence.js';
import type {
  SeeCodebaseRequestValidated,
  SeeCodebaseResult,
} from '../contracts/seeCodebase.js';
import {
  ReadStructuralCompressionPayloadSchema,
  type ReadAstNodeIdentity,
  type ReadStructuralCompressionEntry,
} from '../contracts/seeCodebaseIntelligence.js';
import {
  extractAstNodeIdentities,
  summarizePayloadShape,
} from './seeCodebaseIntelligenceExtract.js';
import { makeReadIntelligenceSidecar } from './seeCodebaseIntelligenceShared.js';
import {
  buildSemanticSearchSidecar,
  type SeeCodebaseSemanticSearch,
} from './seeCodebaseSemanticIntelligence.js';

interface BuildSeeCodebaseAdvisoryIntelligenceArgs {
  request: SeeCodebaseRequestValidated;
  results: readonly SeeCodebaseResult[];
  semanticSearch?: SeeCodebaseSemanticSearch;
  signal?: AbortSignal;
}

export async function buildSeeCodebaseAdvisoryIntelligence({
  request,
  results,
  semanticSearch,
  signal,
}: BuildSeeCodebaseAdvisoryIntelligenceArgs): Promise<
  AdvisoryIntelligenceSidecarEnvelope[]
> {
  const structural = buildStructuralCompressionSidecar(results);
  const semantic = await buildSemanticSearchSidecar({
    request,
    identities: structural.identities,
    ...(semanticSearch !== undefined ? { semanticSearch } : {}),
    ...(signal !== undefined ? { signal } : {}),
  });
  return [structural.sidecar, semantic];
}

function buildStructuralCompressionSidecar(results: readonly SeeCodebaseResult[]): {
  sidecar: AdvisoryIntelligenceSidecarEnvelope;
  identities: ReadAstNodeIdentity[];
} {
  const entries: ReadStructuralCompressionEntry[] = [];
  const identities: ReadAstNodeIdentity[] = [];

  for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
    const result = results[resultIndex];
    if (result === undefined) continue;
    if (result.kind !== 'structural' && result.kind !== 'skeleton') continue;

    const resultIdentities = extractAstNodeIdentities(
      result.payload,
      resultIndex,
      result.readProvenance,
    );
    identities.push(...resultIdentities);
    entries.push({
      resultIndex,
      resultKind: result.kind,
      primitive: result.primitive,
      readProvenance: result.readProvenance,
      rawContentIncluded: false,
      payloadShape: summarizePayloadShape(result.payload),
      astNodeIdentities: resultIdentities,
    });
  }

  const payload = ReadStructuralCompressionPayloadSchema.parse({
    compressionKind: 'structural_read_metadata',
    source: 'seeCodebase',
    rawContentIncluded: false,
    entries,
    totals: {
      structuralResults: entries.length,
      astNodeIdentities: identities.length,
    },
  });

  const provider: AdvisoryIntelligenceProviderState =
    entries.length > 0
      ? {
          providerId: 'tree-sitter-structural-read',
          status: 'available',
          reason: null,
          detail: `summarized ${entries.length} structural result(s)`,
        }
      : {
          providerId: 'tree-sitter-structural-read',
          status: 'unavailable',
          reason: 'no_structural_results',
          detail: 'selected seeCodebase path produced no structural payload',
        };

  return {
    sidecar: makeReadIntelligenceSidecar(
      'read_structural_compression',
      provider,
      payload,
      entries.length > 0
        ? createAdvisoryEvidenceState({ status: 'AVAILABLE' })
        : createAdvisoryEvidenceState({
            status: 'EMPTY',
            reason: 'no_structural_results',
            detail: 'selected seeCodebase path produced no structural payload',
          }),
    ),
    identities,
  };
}
