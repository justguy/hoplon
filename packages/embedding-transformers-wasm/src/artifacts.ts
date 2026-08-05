import type {
  ArtifactKind,
  ArtifactStatus,
  ArtifactVerificationInput,
  ArtifactVerificationResult,
  ArtifactVerifier,
  TransformersWasmEmbeddingOptions,
} from './types.js';

export interface ArtifactState {
  readonly status: ArtifactStatus;
  readonly degradationReasons: string[];
}

export async function describeArtifactState(
  options: TransformersWasmEmbeddingOptions,
  verifyArtifacts: boolean,
): Promise<ArtifactState> {
  const configured = configuredArtifacts(options);
  if (options.localModelPath === undefined || options.wasmPaths === undefined) {
    return {
      status: 'missing',
      degradationReasons: ['local_model_assets_missing'],
    };
  }
  if (!verifyArtifacts) {
    return { status: 'not_loaded', degradationReasons: [] };
  }
  if (configured.length !== 3) {
    return {
      status: 'missing',
      degradationReasons: ['local_artifact_hashes_missing'],
    };
  }
  if (options.artifactVerifier === undefined) {
    return {
      status: 'unverified',
      degradationReasons: ['artifact_verifier_not_bound'],
    };
  }

  const results = await Promise.all(
    configured.map((artifact) => options.artifactVerifier!.verify(artifact)),
  );
  return aggregateArtifactResults(results);
}

export function hasLocalRuntimeAssets(
  options: TransformersWasmEmbeddingOptions,
): boolean {
  return options.localModelPath !== undefined && options.wasmPaths !== undefined;
}

function configuredArtifacts(
  options: TransformersWasmEmbeddingOptions,
): ArtifactVerificationInput[] {
  const artifacts: ArtifactVerificationInput[] = [];
  pushArtifact(artifacts, 'model', options.modelArtifactPath, options.modelArtifactHash);
  pushArtifact(
    artifacts,
    'tokenizer',
    options.tokenizerArtifactPath,
    options.tokenizerArtifactHash,
  );
  pushArtifact(
    artifacts,
    'onnx_wasm',
    options.onnxWasmArtifactPath,
    options.onnxWasmArtifactHash,
  );
  return artifacts;
}

function pushArtifact(
  artifacts: ArtifactVerificationInput[],
  kind: ArtifactKind,
  path: string | undefined,
  expectedSha256: string | undefined,
): void {
  if (path !== undefined && expectedSha256 !== undefined) {
    artifacts.push({ kind, path, expectedSha256 });
  }
}

function aggregateArtifactResults(
  results: readonly ArtifactVerificationResult[],
): ArtifactState {
  const degradationReasons = results
    .map((result) => result.degradationReason)
    .filter((reason): reason is string => reason !== undefined);
  if (results.some((result) => result.status === 'missing')) {
    return { status: 'missing', degradationReasons };
  }
  if (results.some((result) => result.status === 'unverified')) {
    return { status: 'unverified', degradationReasons };
  }
  return { status: 'verified', degradationReasons };
}
