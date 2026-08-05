import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  RbaaAuthorizationDecisionSchema,
  RbaaAuthorizationRequestSchema,
} from '../../src/hoplon/contracts/rbaaAuthorization.js';

const BUNDLE_DIR = resolve(__dirname, '../../policy/rbaa/v1');
const CORPUS_PATH = resolve(BUNDLE_DIR, 'corpus.json');
const OPA_BIN = '/usr/local/bin/opa';

type CorpusCase = {
  id: string;
  description: string;
  shouldPass: boolean;
  expectedOutcome:
    | 'allow'
    | 'requires_escalation'
    | 'requires_approval'
    | 'quarantine'
    | 'deny';
  expectedSource?: 'standing_policy' | 'escalation_grant' | 'risk_adjusted' | 'break_glass';
  expectedEscalationKind?:
    | 'self_service'
    | 'cto_approval'
    | 'human_approval'
    | 'security_approval'
    | 'platform_approval'
    | 'dba_approval';
  input: unknown;
};

type Corpus = {
  policyVersion: string;
  cases: CorpusCase[];
};

type OpaEvalJson = {
  result?: Array<{
    expressions?: Array<{
      value?: unknown;
    }>;
  }>;
};

const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as Corpus;

describe.skipIf(!existsSync(OPA_BIN))('RBAA v1 deployable OPA policy bundle', () => {
  it('passes opa static validation', () => {
    expect(() => {
      execFileSync(OPA_BIN, ['check', BUNDLE_DIR], { encoding: 'utf8' });
    }).not.toThrow();
  });

  it('evaluates the adversarial corpus and emits RBAA v1 decisions', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'hoplon-rbaa-opa-'));
    try {
      expect(corpus.cases.length).toBeGreaterThanOrEqual(8);
      for (const testCase of corpus.cases) {
        const request = RbaaAuthorizationRequestSchema.safeParse(testCase.input);
        expect(request.success, testCase.id).toBe(true);

        const inputPath = join(tempDir, `${testCase.id}.json`);
        writeFileSync(inputPath, JSON.stringify(testCase.input), 'utf8');

        const output = execFileSync(
          OPA_BIN,
          [
            'eval',
            '--format=json',
            '--bundle',
            BUNDLE_DIR,
            '--input',
            inputPath,
            'data.hoplon.rbaa.v1.decision',
          ],
          { encoding: 'utf8' },
        );

        const parsed = JSON.parse(output) as OpaEvalJson;
        const decision = parsed.result?.[0]?.expressions?.[0]?.value;
        const schemaResult = RbaaAuthorizationDecisionSchema.safeParse(decision);
        expect(schemaResult.success, `${testCase.id}: ${JSON.stringify(decision)}`).toBe(true);
        if (!schemaResult.success) continue;

        expect(schemaResult.data.policyVersion).toBe(corpus.policyVersion);
        expect(schemaResult.data.outcome, testCase.id).toBe(testCase.expectedOutcome);
        expect(testCase.shouldPass).toBe(schemaResult.data.outcome === 'allow');

        if (testCase.expectedSource !== undefined && schemaResult.data.outcome === 'allow') {
          expect(schemaResult.data.source).toBe(testCase.expectedSource);
        }
        if (
          testCase.expectedEscalationKind !== undefined &&
          (schemaResult.data.outcome === 'requires_escalation' ||
            schemaResult.data.outcome === 'requires_approval')
        ) {
          expect(schemaResult.data.escalationKind).toBe(testCase.expectedEscalationKind);
        }
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
