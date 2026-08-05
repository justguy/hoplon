/**
 * Structural copy of the small Hoplon CodeIntelligence seam this package needs.
 *
 * The package intentionally does not import `@phalanx/hoplon` at runtime or
 * type-check time. Consumers pass the returned object anywhere a real Hoplon
 * `CodeIntelligenceAdapter` is expected because the shape is compatible.
 */

export interface HoplonSyntaxTree {
  rootNode: { kind: string; children: unknown[] };
}

export interface HoplonSymbol {
  name: string;
  kind: string;
  byteRange: [number, number];
}

export interface HoplonReference {
  path: string;
  byteRange: [number, number];
}

export interface CodeIntelligenceAdapterLike {
  parse(
    file: string,
    content: Uint8Array,
    signal?: AbortSignal,
  ): Promise<HoplonSyntaxTree>;
  getTopLevelSymbols(tree: HoplonSyntaxTree): HoplonSymbol[];
  findReferences?(symbol: HoplonSymbol): Promise<HoplonReference[]>;
  findDependencies?(file: string): Promise<string[]>;
}
