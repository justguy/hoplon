import { posix } from 'node:path';
import { isJsTsFile, normalizePath } from './getRelevantTestsInternal.js';

const CONFIG_BASENAMES = new Set([
  'babel.config.js',
  'babel.config.cjs',
  'babel.config.mjs',
  'babel.config.ts',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.ts',
  'jest.config.js',
  'jest.config.ts',
  'package.json',
  'pnpm-workspace.yaml',
  'postcss.config.js',
  'rollup.config.js',
  'tailwind.config.js',
  'tsconfig.json',
  'turbo.json',
  'vite.config.js',
  'vite.config.ts',
  'vitest.config.js',
  'vitest.config.ts',
  'webpack.config.js',
  'webpack.config.ts',
]);

export function modifiedFilesRequireConservativeCoverage(
  modifiedFiles: readonly string[],
): boolean {
  return modifiedFiles.some((file) => pathRequiresConservativeCoverage(file));
}

export type StaticOracleBlindSpotReason =
  | 'generated_file'
  | 'config_or_package_file'
  | 'non_code_file';

export interface StaticOracleBlindSpotInput {
  source: 'static_oracle';
  reason: StaticOracleBlindSpotReason;
  path: string;
  message: string;
}

export function classifyModifiedFileBlindSpots(
  modifiedFiles: readonly string[],
): StaticOracleBlindSpotInput[] {
  const blindSpots: StaticOracleBlindSpotInput[] = [];
  for (const file of modifiedFiles) {
    const reason = classifyModifiedFileBlindSpotReason(file);
    if (reason === undefined) continue;
    blindSpots.push({
      source: 'static_oracle',
      reason,
      path: file,
      message: blindSpotMessage(reason),
    });
  }
  return blindSpots;
}

export function pathRequiresConservativeCoverage(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  const withoutDot = normalized.replace(/^\.\//, '');
  const basename = posix.basename(withoutDot);
  if (CONFIG_BASENAMES.has(basename)) return true;
  if (basename.endsWith('.config.cjs') || basename.endsWith('.config.mjs')) return true;
  if (basename.endsWith('.config.ts') || basename.endsWith('.config.js')) return true;
  if (basename.startsWith('.') && basename.includes('rc')) return true;
  if (isGeneratedPath(withoutDot)) return true;
  return !isJsTsFile(withoutDot);
}

function isGeneratedPath(filePath: string): boolean {
  const segments = filePath.split('/');
  if (segments.some((segment) => segment === 'generated' || segment === '__generated__')) {
    return true;
  }
  return posix.basename(filePath).includes('.generated.');
}

function classifyModifiedFileBlindSpotReason(
  filePath: string,
): StaticOracleBlindSpotReason | undefined {
  const normalized = normalizePath(filePath);
  const withoutDot = normalized.replace(/^\.\//, '');
  const basename = posix.basename(withoutDot);
  if (isGeneratedPath(withoutDot)) return 'generated_file';
  if (CONFIG_BASENAMES.has(basename)) return 'config_or_package_file';
  if (basename.endsWith('.config.cjs') || basename.endsWith('.config.mjs')) {
    return 'config_or_package_file';
  }
  if (basename.endsWith('.config.ts') || basename.endsWith('.config.js')) {
    return 'config_or_package_file';
  }
  if (basename.startsWith('.') && basename.includes('rc')) {
    return 'config_or_package_file';
  }
  return isJsTsFile(withoutDot) ? undefined : 'non_code_file';
}

function blindSpotMessage(reason: StaticOracleBlindSpotReason): string {
  switch (reason) {
    case 'generated_file':
      return 'Generated-file changes can bypass static import graph coverage.';
    case 'config_or_package_file':
      return 'Config/package changes can affect tests through framework tooling.';
    case 'non_code_file':
      return 'Non-code changes are outside the JS/TS static import graph.';
  }
}
