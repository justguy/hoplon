import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createDefaultHoplonEngine,
  createHoplonEditSession,
  createNodeFsAdapter,
} from '../dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const grammarsDir = path.resolve(here, '../vendor/grammars');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hoplon-public-example-'));
const relativeFile = 'src/greet.ts';
const absoluteFile = path.join(root, relativeFile);

const baseline = [
  'export function greet(name) {',
  '  return `Hello, ${name}`;',
  '}',
  '',
  "export const language = 'en';",
  '',
].join('\n');

const allowed = baseline.replace('Hello,', 'Welcome,');
const violating = `${allowed}export const UNCONTRACTED = true;\n`;

function manifest(runId) {
  return {
    manifestSchemaVersion: 2,
    projectId: 'public-example',
    runId,
    correlationId: `bounded-edit-${runId}`,
    entries: [
      {
        path: relativeFile,
        intent: 'modify',
        scope: { kind: 'symbols', symbols: ['greet'] },
      },
    ],
  };
}

try {
  fs.mkdirSync(path.dirname(absoluteFile), { recursive: true });
  fs.mkdirSync(path.join(root, '.hoplon'), { recursive: true });
  fs.writeFileSync(absoluteFile, baseline);

  const engine = await createDefaultHoplonEngine({
    root,
    dbPath: path.join(root, '.hoplon', 'hoplon.db'),
    gitRepoDir: path.join(root, '.hoplon', 'repo'),
    grammarsDir,
    engineId: 'public-example-engine',
  });
  const adapter = createNodeFsAdapter({ root });

  const passSession = createHoplonEditSession({
    engine,
    manifest: manifest('pass'),
    fs: adapter,
  });
  await passSession.preflight();
  await passSession.createSnapshot();
  const passDryRun = await passSession.dryRun([
    { file: relativeFile, content: allowed },
  ]);
  await passSession.applyEdits([{ file: relativeFile, content: allowed }]);
  const passAudit = await passSession.audit();
  passSession.close();

  const blockSession = createHoplonEditSession({
    engine,
    manifest: manifest('block'),
    fs: adapter,
  });
  await blockSession.preflight();
  await blockSession.createSnapshot();
  await blockSession.applyEdits([
    { file: relativeFile, content: violating },
  ]);
  const blockAudit = await blockSession.audit();
  if (blockAudit.status !== 'BLOCK') {
    throw new Error('expected the out-of-scope symbol to be blocked');
  }
  await blockSession.revert();
  const rollback = await blockSession.extractRollbackTemplate();
  blockSession.close();

  const restored = fs.readFileSync(absoluteFile, 'utf8');
  if (restored !== allowed) {
    throw new Error('revert did not restore the last accepted baseline');
  }

  console.log(JSON.stringify({
    allowedEdit: {
      dryRun: passDryRun.status,
      audit: passAudit.status,
    },
    violatingEdit: {
      audit: blockAudit.status,
      violations: blockAudit.violations.map(({ kind, path: violationPath }) => ({
        kind,
        path: violationPath,
      })),
      revertedToLastAcceptedBaseline: restored === allowed,
      rollbackFiles: rollback.files.map(({ path: rollbackPath }) => rollbackPath),
    },
  }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
