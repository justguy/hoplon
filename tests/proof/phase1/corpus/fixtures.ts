/**
 * tests/proof/phase1/corpus/fixtures.ts — Adversarial JS/TS corpus for the Phase 1 proof suite.
 *
 * Each constant is a source string that can be written to an in-memory filesystem.
 * These are TEST DATA only — not production code.
 *
 * The corpus covers:
 *   - functions.ts: top-level named function, arrow const, function expression
 *   - reformatted.ts: same as functions.ts, different formatting (proves H7 / AS reformatter PASS)
 *   - classes.ts: class with constructor + methods; subclass with override; static methods
 *   - generics.ts: generic function, generic class, generic method
 *   - overloads.ts: TypeScript function overloads (multiple signatures)
 *   - decorators.ts: class decorator, method decorator
 *   - exports.ts: named exports, default export, re-exports
 *   - imports.ts: default import, named imports, namespace import, type-only import
 *   - mixed.tsx: JSX component with TypeScript
 *   - broken.ts: intentionally broken syntax (for parse_failure tests)
 *   - awsKeyFile.ts: file with AWS key fixture (for secret scanning tests)
 */

// ---------------------------------------------------------------------------
// functions.ts — top-level named function, arrow const, function expression
// ---------------------------------------------------------------------------

export const FUNCTIONS_TS = `
function foo(x: number): number {
  return x * 2;
}

const bar = (x: number): number => x + 1;

const baz = function(x: number): number {
  return x - 1;
};
`.trimStart();

// ---------------------------------------------------------------------------
// reformatted.ts — same structural shape as functions.ts's `foo` only, with
// different formatting (indent, no semicolons, different whitespace).
//
// This is a SINGLE-FUNCTION file so the reformatter proof is clean:
// scope is ['foo'], and 'foo' exists in both original and reformatted.
// There are no other top-level symbols to trigger out_of_scope_symbol.
//
// Proves H7 / AS audit-by-structural-shape: a pure reformatter pass → PASS
// ---------------------------------------------------------------------------

/** Single-function file for the reformatter test — matches FOO_ONLY_TS structure */
export const FOO_ONLY_TS = `function foo(x: number): number {
  return x * 2;
}
`;

/** Same function, different Prettier-style formatting — no structural change */
export const REFORMATTED_TS = `function foo(x: number): number {
    return x * 2
}
`;

// ---------------------------------------------------------------------------
// classes.ts — class with constructor + methods; subclass; static methods
// ---------------------------------------------------------------------------

export const CLASSES_TS = `
class Animal {
  name: string;

  constructor(name: string) {
    this.name = name;
  }

  speak(): string {
    return \`\${this.name} makes a noise.\`;
  }

  static create(name: string): Animal {
    return new Animal(name);
  }
}

class Dog extends Animal {
  breed: string;

  constructor(name: string, breed: string) {
    super(name);
    this.breed = breed;
  }

  speak(): string {
    return \`\${this.name} barks.\`;
  }
}
`.trimStart();

// ---------------------------------------------------------------------------
// generics.ts — generic function, generic class, generic method
// ---------------------------------------------------------------------------

export const GENERICS_TS = `
function identity<T>(value: T): T {
  return value;
}

class Box<T> {
  private value: T;

  constructor(value: T) {
    this.value = value;
  }

  getValue(): T {
    return this.value;
  }

  map<U>(fn: (v: T) => U): Box<U> {
    return new Box(fn(this.value));
  }
}
`.trimStart();

// ---------------------------------------------------------------------------
// overloads.ts — TypeScript function overloads
// ---------------------------------------------------------------------------

export const OVERLOADS_TS = `
function process(x: string): string;
function process(x: number): number;
function process(x: string | number): string | number {
  if (typeof x === 'string') {
    return x.toUpperCase();
  }
  return x * 2;
}
`.trimStart();

// ---------------------------------------------------------------------------
// decorators.ts — class decorator, method decorator (experimental syntax)
// Uses legacy decorator syntax (@decorator) as stage 3 still not in tree-sitter
// ---------------------------------------------------------------------------

export const DECORATORS_TS = `
function sealed(constructor: Function) {
  Object.seal(constructor);
  Object.seal(constructor.prototype);
}

function enumerable(value: boolean) {
  return function(target: unknown, propertyKey: string, descriptor: PropertyDescriptor) {
    descriptor.enumerable = value;
  };
}

@sealed
class BugReport {
  type = 'report';
  title: string;

  constructor(t: string) {
    this.title = t;
  }

  @enumerable(false)
  greet(): string {
    return \`Hello, \${this.title}\`;
  }
}
`.trimStart();

// ---------------------------------------------------------------------------
// exports.ts — named exports, default export, re-exports
// ---------------------------------------------------------------------------

export const EXPORTS_TS = `
export function namedExportFn(): void {
  // named export function
}

export class NamedExportClass {
  method(): void {}
}

export const namedExportConst = 42;

export default function defaultExportFn(): void {
  // default export
}
`.trimStart();

// ---------------------------------------------------------------------------
// imports.ts — default import, named imports, namespace import, type-only import
// ---------------------------------------------------------------------------

export const IMPORTS_TS = `
import defaultImport from './some-module.js';
import { namedA, namedB } from './another-module.js';
import * as ns from './namespace-module.js';
import type { SomeType } from './type-module.js';

function useImports(): void {
  console.log(defaultImport, namedA, namedB, ns);
}
`.trimStart();

// ---------------------------------------------------------------------------
// mixed.tsx — JSX component with TypeScript
// ---------------------------------------------------------------------------

export const MIXED_TSX = `
import React from 'react';

interface ButtonProps {
  label: string;
  onClick: () => void;
}

function Button({ label, onClick }: ButtonProps): JSX.Element {
  return (
    <button onClick={onClick}>
      {label}
    </button>
  );
}

const Counter: React.FC = () => {
  const [count, setCount] = React.useState(0);
  return (
    <div>
      <Button label="Increment" onClick={() => setCount(c => c + 1)} />
      <span>{count}</span>
    </div>
  );
};

export { Button, Counter };
`.trimStart();

// ---------------------------------------------------------------------------
// broken.ts — intentionally broken JS syntax for parse_failure tests
// ---------------------------------------------------------------------------

export const BROKEN_JS = `
function brokenFunction({
  // Unclosed brace — syntax error
  const x = 1
  return
`.trimStart();

// ---------------------------------------------------------------------------
// awsKeyFile.ts — file with an AWS key fixture for secret scanning tests
// ---------------------------------------------------------------------------

// This key is intentionally fake (format-compliant but not a real key).
// It is here for testing that the scanner detects and REDACTS it.
export const AWS_ACCESS_KEY_FIXTURE = 'AKIAIOSFODNN7EXAMPLE';
export const AWS_KEY_FILE_TS = `
// Configuration file
const config = {
  region: 'us-east-1',
  accessKeyId: '${AWS_ACCESS_KEY_FIXTURE}',
  endpoint: 'https://example.amazonaws.com',
};
`.trimStart();
