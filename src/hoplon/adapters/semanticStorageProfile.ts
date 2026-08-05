export type SemanticStorageProfileKind =
  | 'wasm_sqlite_fts_vector'
  | 'durable_js_lexical_vector'
  | 'lexical_only_degraded'
  | 'native_sqlite_vec';

export type SemanticStorageProfileStatus = 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE';

export interface SemanticStorageProfile {
  readonly kind: SemanticStorageProfileKind;
  readonly status: SemanticStorageProfileStatus;
  readonly durableLexical: boolean;
  readonly durableVector: boolean;
  readonly nativeRuntime: boolean;
  readonly degradationReasons: string[];
}

export interface SemanticStorageProfileAdapter {
  describe(): Promise<SemanticStorageProfile>;
}

const NOOP_SEMANTIC_STORAGE_PROFILE_BRAND = Symbol(
  'hoplon.noopSemanticStorageProfile',
);

type BrandedSemanticStorageProfileAdapter = SemanticStorageProfileAdapter & {
  [NOOP_SEMANTIC_STORAGE_PROFILE_BRAND]?: true;
};

export function createNoopSemanticStorageProfile(): SemanticStorageProfileAdapter {
  const adapter: BrandedSemanticStorageProfileAdapter = {
    [NOOP_SEMANTIC_STORAGE_PROFILE_BRAND]: true,
    async describe(): Promise<SemanticStorageProfile> {
      return {
        kind: 'lexical_only_degraded',
        status: 'UNAVAILABLE',
        durableLexical: false,
        durableVector: false,
        nativeRuntime: false,
        degradationReasons: ['semantic_storage_profile_provider_not_bound'],
      };
    },
  };
  return adapter;
}

export function isNoopSemanticStorageProfileAdapter(
  adapter: SemanticStorageProfileAdapter | null | undefined,
): boolean {
  return Boolean(
    (adapter as BrandedSemanticStorageProfileAdapter | null | undefined)?.[
      NOOP_SEMANTIC_STORAGE_PROFILE_BRAND
    ],
  );
}
