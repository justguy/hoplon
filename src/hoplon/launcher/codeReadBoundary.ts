/**
 * launcher/codeReadBoundary.ts — `t-075` code-only replacement boundary.
 *
 * Split from `liveUseDefaults.ts` so the 300-line architecture cap stays
 * intact and the `t-075` contract (type + canonical constant) has one
 * owning file.
 *
 * Scope discipline (read before editing):
 *   - this boundary claim is intentionally narrow: supported non-binary
 *     code files and code-adjacent raw text inside them. It is NOT a
 *     generic repo-text replacement claim.
 *   - `authoritativeSurface` is the already-shipped `engine.seeCodebase`.
 *     `t-075` does not introduce a second agent-facing file-access
 *     mechanism; it narrows the replacement claim around the existing
 *     surface.
 *   - `outOfScope` keeps non-code repo text (docs/configs/env/logs) and
 *     binary content explicit rather than hiding them behind fallback
 *     drift.
 */

/**
 * `t-075` — code-only replacement boundary over the packaged read/search
 * surface.
 */
export interface CodeReadReplacementBoundary {
  /** `t-075` narrows the claim to supported non-binary code work only. */
  scope: 'supported_non_binary_code';
  /** The shipped `t-061` macro — no parallel surface is introduced. */
  authoritativeSurface: 'engine.seeCodebase';
  /** Packaged transports that project the same surface. */
  transports: readonly [
    'engine.seeCodebase (in-process)',
    'see_codebase (MCP)',
    'hoplon query see (CLI)',
    'POST /seeCodebase (HTTP)',
  ];
  /**
   * Already-shipped primitives on the packaged path that serve the code
   * boundary. `rawFileRead` / `rawTextSearch` are what the host raw
   * companion used to cover on supported code files; `packContext`,
   * `searchSymbols`, and `extractStructuralTemplate` cover the structural
   * JS/TS code-understanding routes on the same surface.
   */
  codePrimitives: readonly [
    'rawFileRead',
    'rawTextSearch',
    'packContext',
    'searchSymbols',
    'extractStructuralTemplate',
  ];
  /**
   * Hard invariant on the code boundary: the host raw-text / file
   * companion is not load-bearing for supported non-binary code work.
   * Fallbacks in `liveUseDefaults.fallbacks` remain load-bearing only for
   * the narrower scopes named there.
   */
  hostCompanionLoadBearing: false;
  /**
   * What counts as "supported non-binary code work" in practice under the
   * `t-075` replacement claim.
   */
  inScope: readonly string[];
  /**
   * Categories that remain explicitly outside the code-only replacement
   * claim. Keeping this list honest prevents the bundle from pretending
   * the packaged path replaces arbitrary repo-text tooling.
   */
  outOfScope: readonly {
    category: string;
    stillOwnedBy: 'host_raw_companion';
    reason: string;
  }[];
}

/**
 * Canonical `t-075` boundary. Declared once so tests, docs, and the
 * status envelope all read the same truth.
 */
export const HOPLON_CODE_READ_REPLACEMENT: CodeReadReplacementBoundary = {
  scope: 'supported_non_binary_code',
  authoritativeSurface: 'engine.seeCodebase',
  transports: [
    'engine.seeCodebase (in-process)',
    'see_codebase (MCP)',
    'hoplon query see (CLI)',
    'POST /seeCodebase (HTTP)',
  ] as const,
  codePrimitives: [
    'rawFileRead',
    'rawTextSearch',
    'packContext',
    'searchSymbols',
    'extractStructuralTemplate',
  ] as const,
  hostCompanionLoadBearing: false,
  inScope: [
    'non-binary source files of programming languages (e.g. .ts/.tsx/.js/.jsx/.mjs/.cjs/.py/.go/.rs/.java/.kt/.rb/.c/.h/.cc/.cpp/.cs/.php/.swift/.m/.mm/.scala/.sh/.sql)',
    'code-adjacent raw text inside those files (comments, string literals, copyright/license headers, inline directives, pragmas)',
    'exact-text reads of supported non-binary code files through engine.seeCodebase',
    'raw text search over code scopes through engine.seeCodebase',
    'structural JS/TS reads via packContext / extractStructuralTemplate / searchSymbols on the same surface',
  ] as const,
  outOfScope: [
    {
      category: 'non_code_repo_text_docs',
      stillOwnedBy: 'host_raw_companion',
      reason:
        'Markdown/RST/plaintext docs are not supported code files under this replacement claim; see_codebase still serves them through the raw primitives at runtime, but the load-bearing ownership for docs search/read remains host-owned (rg / cat / IDE viewer / filesystem MCP tool)',
    },
    {
      category: 'non_code_repo_text_configs',
      stillOwnedBy: 'host_raw_companion',
      reason:
        'YAML/TOML/INI/JSON5/env configuration and environment files are explicitly outside the supported code boundary; the host raw companion remains the named owner of their read/search surface',
    },
    {
      category: 'non_code_repo_text_env_and_logs',
      stillOwnedBy: 'host_raw_companion',
      reason:
        '.env files, log files, rotated runtime output, and other operational repo text are not supported code work under this claim and stay under the host raw companion',
    },
    {
      category: 'binary_files',
      stillOwnedBy: 'host_raw_companion',
      reason:
        'binary content is explicitly excluded from the code-only replacement boundary; rawTextSearch skips binary-looking bytes and rawFileRead is UTF-8-text only, so binary handling is not part of the t-075 claim',
    },
  ] as const,
};
