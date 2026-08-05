/** Architecture proof for AGENTS.md law #1: Hoplon source files stay at or below 300 lines. */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HOPLON_SRC = resolve(ROOT, 'src/hoplon');
const MAX_LINES = 300;

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : [path];
    })
    .filter((path) => extname(path) === '.ts')
    .sort();
}

function lineCount(source: string): number {
  if (source.length === 0) return 0;
  const lines = source.split('\n').length;
  return source.endsWith('\n') ? lines - 1 : lines;
}

describe('Hoplon 300-line architecture limit', () => {
  it('positive gate — every src/hoplon TypeScript file is within the limit', () => {
    const violations = sourceFiles(HOPLON_SRC)
      .map((path) => ({
        path: relative(ROOT, path),
        lines: lineCount(readFileSync(path, 'utf8')),
      }))
      .filter(({ lines }) => lines > MAX_LINES);

    expect(violations, 'Oversized Hoplon source files').toEqual([]);
  });

  it('negative gate — a 301-line source is rejected', () => {
    expect(lineCount(Array.from({ length: 301 }, () => 'x').join('\n'))).toBe(
      MAX_LINES + 1,
    );
  });
});
