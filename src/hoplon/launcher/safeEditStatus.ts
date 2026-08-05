import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_PARSE_TIMEOUT_MS,
} from '../engine/defaults.js';
import {
  TREE_SITTER_MAX_FILE_BYTES,
  TREE_SITTER_SUPPORTED_LANGUAGES,
} from '../adapters/codeIntelligence/treeSitterLimits.js';
import {
  STAGE_MAX_CHUNK_BYTES,
  STAGE_MAX_ENTRIES_PER_SESSION,
  STAGE_MAX_TOTAL_BYTES,
} from '../session/stagingStore.js';

type CapabilityStatus = 'available' | 'degraded' | 'unavailable';

export interface SafeEditLockTopologyReport {
  providerInjection: 'launcher_shared_in_process_by_default';
  omittedProviderBehavior: 'lock_free_degraded';
  lockUniverseScope: 'per_lock_provider_instance';
  crossLauncherSerialization: 'not_guaranteed_without_shared_distributed_provider';
  distributedProviderSupport: 'available_when_host_binds_shared_provider';
  protects: readonly [
    'ast_node_overlap',
    'same_file_structural_commit',
    'same_file_textual_write',
  ];
  doesNotProtect: readonly [
    'semantic_dependencies',
    'imports',
    'dto_field_coupling',
    'routes',
    'shared_contracts',
    'os_level_writes',
  ];
}

export interface SafeEditCapabilityReport {
  entry: 'createHoplonEditSession.applyEdits';
  contentMode: 'utf8_text_only';
  transportMode: 'bounded_json_requests';
  stagingMode: 'session_scoped_base64_chunks';
  writeVariants: {
    fullFile: 'available';
    patch: 'available';
    structural: 'available' | 'unavailable';
  };
  requirements: {
    fsAdapter: 'required';
    codeIntelligenceForStructural: 'required';
  };
  lockTopology: SafeEditLockTopologyReport;
  limits: {
    maxFileBytes: number;
    parseTimeoutMs: number;
    structuralHardCeilingBytes: number;
    chunkedUploadMaxChunkBytes: number;
    chunkedUploadMaxTotalBytes: number;
    chunkedUploadMaxEntriesPerSession: number;
  };
  unsupported: {
    binaryFiles: false;
    chunkedUpload: true;
    streamingUpload: false;
    nodeScopedLocks: true;
  };
  structuralScope: {
    targeting: 'top_level_symbol_or_symbol_path';
    supportedLanguages: readonly ['javascript', 'typescript', 'tsx'];
  };
}

export function buildSafeEditCapabilityReport(opts: {
  readonly codeIntelligenceStatus: CapabilityStatus;
  readonly grammarsPresent: boolean;
}): SafeEditCapabilityReport {
  return {
    entry: 'createHoplonEditSession.applyEdits',
    contentMode: 'utf8_text_only',
    transportMode: 'bounded_json_requests',
    stagingMode: 'session_scoped_base64_chunks',
    writeVariants: {
      fullFile: 'available',
      patch: 'available',
      structural:
        opts.codeIntelligenceStatus === 'available' && opts.grammarsPresent
          ? 'available'
          : 'unavailable',
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
      maxFileBytes: DEFAULT_MAX_FILE_BYTES,
      parseTimeoutMs: DEFAULT_PARSE_TIMEOUT_MS,
      structuralHardCeilingBytes: TREE_SITTER_MAX_FILE_BYTES,
      chunkedUploadMaxChunkBytes: STAGE_MAX_CHUNK_BYTES,
      chunkedUploadMaxTotalBytes: STAGE_MAX_TOTAL_BYTES,
      chunkedUploadMaxEntriesPerSession: STAGE_MAX_ENTRIES_PER_SESSION,
    },
    unsupported: {
      binaryFiles: false,
      chunkedUpload: true,
      streamingUpload: false,
      nodeScopedLocks: true,
    },
    structuralScope: {
      targeting: 'top_level_symbol_or_symbol_path',
      supportedLanguages: TREE_SITTER_SUPPORTED_LANGUAGES,
    },
  };
}
