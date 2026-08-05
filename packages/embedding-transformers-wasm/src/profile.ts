import { sha256StableJson } from './hash.js';
import type { EmbeddingAdapterDescription } from './types.js';

export function computeEmbeddingProfileHash(
  description: Omit<EmbeddingAdapterDescription, 'embeddingProfileHash'>,
): string {
  return sha256StableJson({
    adapterContractVersion: description.contractVersion,
    backendProfile: description.backendProfile,
    corpusSchemaVersion: description.corpusSchemaVersion,
    dimensions: description.dimensions,
    embeddingModelId: description.embeddingModelId,
    embeddingPackage: description.embeddingPackage,
    embeddingPackageVersion: description.embeddingPackageVersion,
    modelArtifactHash: description.modelArtifactHash,
    normalize: description.normalize,
    onnxBackend: description.onnxBackend,
    onnxRuntimeWebPackageVersion: description.onnxRuntimeWebPackageVersion,
    onnxWasmArtifactHash: description.onnxWasmArtifactHash,
    pooling: description.pooling,
    runtimeProfile: description.runtimeProfile,
    tokenizerArtifactHash: description.tokenizerArtifactHash,
  });
}
