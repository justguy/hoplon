/**
 * Architecture test: LGPL isolation — @phalanx/hoplon core must never bundle
 * LGPL-licensed packages.
 *
 * ADR 0001 D15: Semgrep is LGPL — the integration ships as a separate plugin
 * package (@phalanx/hoplon-static-analysis-semgrep), never bundled into the
 * MIT-licensed core.
 *
 * Two duties:
 * 1. Dependency check — asserts @phalanx/hoplon-static-analysis-semgrep is NOT
 *    listed in root package.json dependencies or devDependencies.
 * 2. Known-LGPL-packages check — asserts no known LGPL-licensed package name
 *    appears as a direct dependency in root package.json.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const CORE_PKG_PATH = resolve(ROOT, 'package.json');

// ---------------------------------------------------------------------------
// Known LGPL package names
// Extend this list as new LGPL plugin packages are added to the project.
// The semgrep package is the canonical example per ADR 0001 D15.
// ---------------------------------------------------------------------------

const KNOWN_LGPL_PACKAGES: readonly string[] = [
  '@phalanx/hoplon-static-analysis-semgrep',
  // semgrep itself — if someone accidentally adds it as a direct dep
  'semgrep',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  [key: string]: unknown;
}

function readPackageJson(path: string): PackageJson {
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as PackageJson;
}

function allDependencyNames(pkg: PackageJson): string[] {
  return [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LGPL isolation — core package.json', () => {
  it('core package.json does not list @phalanx/hoplon-static-analysis-semgrep in any dep field', () => {
    const pkg = readPackageJson(CORE_PKG_PATH);
    const deps = allDependencyNames(pkg);

    expect(
      deps,
      '@phalanx/hoplon-static-analysis-semgrep must NOT appear in core dependencies, ' +
        'devDependencies, or peerDependencies. It is LGPL-2.1-or-later and must remain ' +
        'in its own plugin package per ADR 0001 D15.',
    ).not.toContain('@phalanx/hoplon-static-analysis-semgrep');
  });

  it('core package.json does not list any known LGPL package as a direct dependency', () => {
    const pkg = readPackageJson(CORE_PKG_PATH);
    const deps = allDependencyNames(pkg);

    const violations: string[] = [];
    for (const lgplPkg of KNOWN_LGPL_PACKAGES) {
      if (deps.includes(lgplPkg)) {
        violations.push(lgplPkg);
      }
    }

    expect(
      violations,
      `The following LGPL-licensed package(s) were found as direct dependencies in core: ` +
        `${violations.join(', ')}. ` +
        `These must only live in separate plugin packages per ADR 0001 D15.`,
    ).toHaveLength(0);
  });

  it('core package name is @phalanx/hoplon (sanity check)', () => {
    const pkg = readPackageJson(CORE_PKG_PATH);
    expect(pkg.name).toBe('@phalanx/hoplon');
  });

  it('semgrep plugin package.json declares license as LGPL-2.1-or-later', () => {
    const pluginPkgPath = resolve(
      ROOT,
      'packages/static-analysis-semgrep/package.json',
    );
    const pkg = readPackageJson(pluginPkgPath);
    expect(
      pkg['license'],
      'packages/static-analysis-semgrep/package.json must declare "license": "LGPL-2.1-or-later"',
    ).toBe('LGPL-2.1-or-later');
  });

  it('semgrep plugin package name is @phalanx/hoplon-static-analysis-semgrep', () => {
    const pluginPkgPath = resolve(
      ROOT,
      'packages/static-analysis-semgrep/package.json',
    );
    const pkg = readPackageJson(pluginPkgPath);
    expect(pkg.name).toBe('@phalanx/hoplon-static-analysis-semgrep');
  });

  it('semgrep plugin package.json has @phalanx/hoplon as peerDependency (not dep)', () => {
    const pluginPkgPath = resolve(
      ROOT,
      'packages/static-analysis-semgrep/package.json',
    );
    const pkg = readPackageJson(pluginPkgPath);

    // Must be in peerDependencies
    const peerDeps = Object.keys(pkg.peerDependencies ?? {});
    expect(peerDeps).toContain('@phalanx/hoplon');

    // Must NOT be in dependencies (that would bundle core into the plugin)
    const deps = Object.keys(pkg.dependencies ?? {});
    expect(deps).not.toContain('@phalanx/hoplon');
  });

  it('semgrep plugin package.json has no runtime dependencies (uses only child_process + peer)', () => {
    const pluginPkgPath = resolve(
      ROOT,
      'packages/static-analysis-semgrep/package.json',
    );
    const pkg = readPackageJson(pluginPkgPath);
    const deps = pkg.dependencies ?? {};
    expect(
      Object.keys(deps),
      'Semgrep plugin should have no runtime dependencies — it uses Node built-in child_process ' +
        'and @phalanx/hoplon via peerDependencies.',
    ).toHaveLength(0);
  });
});
