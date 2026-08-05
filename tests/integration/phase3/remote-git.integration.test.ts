/**
 * tests/integration/phase3/remote-git.integration.test.ts
 *
 * Integration test for remote git push/fetch against a real remote.
 *
 * Gated by: RUN_INTEGRATION=1 env var.
 * Also requires:
 *   HOPLON_GIT_REMOTE_URL   — HTTPS URL of the test remote (e.g. https://github.com/org/repo.git)
 *   HOPLON_GIT_USERNAME     — GitHub username or "x-access-token"
 *   HOPLON_GIT_PASSWORD     — GitHub personal access token (PAT) with repo:write scope
 *
 * These tests push to and fetch from a REAL remote. Never run in CI without
 * appropriate secrets and a dedicated test repository.
 *
 * Usage:
 *   RUN_INTEGRATION=1 \
 *   HOPLON_GIT_REMOTE_URL=https://github.com/org/hoplon-test-remote.git \
 *   HOPLON_GIT_USERNAME=x-access-token \
 *   HOPLON_GIT_PASSWORD=ghp_xxx \
 *   npx vitest run tests/integration/phase3/remote-git.integration.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createIsomorphicGitVersioning } from '../../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createMemFsAdapter } from '../../../src/hoplon/adapters/fs/memfs.js';
import { createFsShim } from '../../../src/hoplon/adapters/versioning/fsShim.js';
import * as git from 'isomorphic-git';

const RUN = process.env['RUN_INTEGRATION'] === '1';
const REMOTE_URL = process.env['HOPLON_GIT_REMOTE_URL'] ?? '';
const USERNAME = process.env['HOPLON_GIT_USERNAME'] ?? '';
const PASSWORD = process.env['HOPLON_GIT_PASSWORD'] ?? '';

// ---------------------------------------------------------------------------
// Guard: skip the entire suite if not enabled or configured
// ---------------------------------------------------------------------------
if (!RUN) {
  describe.skip('Remote git integration (RUN_INTEGRATION=1 required)', () => {
    it('skipped', () => {});
  });
} else {
  describe('Remote git integration', () => {
    beforeAll(() => {
      if (!REMOTE_URL || !USERNAME || !PASSWORD) {
        throw new Error(
          'Set HOPLON_GIT_REMOTE_URL, HOPLON_GIT_USERNAME, and HOPLON_GIT_PASSWORD to run integration tests',
        );
      }
    });

    it('push then fetch round-trip against real remote', async () => {
      const credentials = { username: USERNAME, password: PASSWORD };

      // Build source repo with a unique commit
      const sourceFs = createMemFsAdapter();
      const sourceVersioning = createIsomorphicGitVersioning({ fs: sourceFs });
      await sourceVersioning.init('/source');

      const timestamp = Math.floor(Date.now() / 1000);
      const content = `integration test ${timestamp}`;
      await sourceFs.write('/source/integration.txt', new TextEncoder().encode(content));
      await sourceVersioning.add('/source', ['integration.txt']);
      const { sha: pushedSha } = await sourceVersioning.commit('/source', `integration push ${timestamp}`, {
        committer: { timestamp },
      });

      // Push to the real remote
      await sourceVersioning.push({
        repoDir: '/source',
        remote: REMOTE_URL,
        ref: 'main',
        credentials,
      });

      // Fetch from the real remote into a fresh clone
      const cloneFs = createMemFsAdapter();
      const cloneVersioning = createIsomorphicGitVersioning({ fs: cloneFs });
      await cloneVersioning.init('/clone');

      await cloneVersioning.fetch({
        repoDir: '/clone',
        remote: REMOTE_URL,
        ref: 'main',
        credentials,
      });

      // Verify FETCH_HEAD matches the SHA we pushed
      const cloneShim = createFsShim(cloneFs);
      const fetchHead = await git.resolveRef({ fs: cloneShim, dir: '/clone', ref: 'FETCH_HEAD' });
      expect(fetchHead).toBe(pushedSha);
    }, 60_000 /* 60s timeout for real network */);
  });
}
