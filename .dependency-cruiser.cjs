/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'hoplon-no-pipeline',
      severity: 'error',
      comment: 'Hoplon must not import from pipeline layers',
      from: { path: '^src/hoplon/' },
      to: { path: 'pipeline' },
    },
    {
      name: 'hoplon-no-agents',
      severity: 'error',
      comment: 'Hoplon must not import from agent layers',
      from: { path: '^src/hoplon/' },
      to: { path: 'agents' },
    },
    {
      name: 'hoplon-no-process-ledger',
      severity: 'error',
      comment: 'Hoplon must not import from process-ledger',
      from: { path: '^src/hoplon/' },
      to: { path: 'process-ledger' },
    },
    {
      name: 'hoplon-no-adr-graph',
      severity: 'error',
      comment: 'Hoplon must not import from adr-graph',
      from: { path: '^src/hoplon/' },
      to: { path: 'adr-graph' },
    },
    {
      name: 'hoplon-no-semantic-runtime-packages',
      severity: 'error',
      comment: 'Semantic-search runtimes must bind through adapters, not core imports',
      from: { path: '^src/hoplon/' },
      to: {
        path: '(sqlite-vec|better-sqlite3|hnswlib|@huggingface/transformers|@xenova/transformers|onnxruntime|@babel/parser|ts-morph)',
      },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    exclude: {
      path: '(node_modules|dist|vendor)',
    },
    tsPreCompilationDeps: false,
    moduleSystems: ['es6', 'cjs'],
    externalModuleResolutionStrategy: 'node_modules',
    tsConfig: {
      fileName: 'tsconfig.json',
    },
    reporterOptions: {
      err: {
        showRules: true,
      },
    },
  },
};
