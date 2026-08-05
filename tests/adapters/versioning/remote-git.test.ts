/**
 * tests/adapters/versioning/remote-git.test.ts
 *
 * Unit tests for the remote push/fetch implementation in createIsomorphicGitVersioning.
 *
 * All tests are fully in-process — no real network calls.
 * The remote is a bare isomorphic-git repo backed by a separate memfs instance.
 * An in-process HTTP transport routes git smart HTTP requests directly to the
 * bare repo.
 *
 * ## Coverage
 *
 * 1. push to local bare remote → remote HEAD advances to pushed commit SHA
 * 2. fetch from local bare remote → refs/remotes/hoplon-origin/main updated
 * 3. push with auth failure (cancelled auth) → AdapterError({ kind: 'remote_push_failed' })
 * 4. round-trip: init bare → commit → push → fetch into second clone → same SHA via remote-tracking ref
 * 5. disableRemote:true push → EngineError({ kind: 'remote_not_supported' })
 * 6. disableRemote:true fetch → EngineError({ kind: 'remote_not_supported' })
 * 7. push error kind is 'remote_push_failed'
 * 8. fetch error kind is 'remote_fetch_failed'
 */

import { describe, it, expect } from 'vitest';
import * as git from 'isomorphic-git';
import { createIsomorphicGitVersioning } from '../../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createFsShim } from '../../../src/hoplon/adapters/versioning/fsShim.js';
import { createMemFsAdapter } from '../../../src/hoplon/adapters/fs/memfs.js';
import { AdapterError, EngineError } from '../../../src/hoplon/contracts/errors.js';
import type { HoplonFsAdapter } from '../../../src/hoplon/adapters/fs.js';
import type { HttpClient } from 'isomorphic-git';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a UTF-8 file via the fs adapter. */
async function writeFile(adapter: HoplonFsAdapter, path: string, content: string): Promise<void> {
  await adapter.write(path, new TextEncoder().encode(content));
}

/** Build a fresh source repo with one commit and return the SHA. */
async function buildSourceRepo(dir = '/source') {
  const fsAdapter = createMemFsAdapter();
  const versioning = createIsomorphicGitVersioning({ fs: fsAdapter });
  await versioning.init(dir);
  await writeFile(fsAdapter, `${dir}/file.txt`, 'hello from source');
  await versioning.add(dir, ['file.txt']);
  const { sha } = await versioning.commit(dir, 'initial commit', { committer: { timestamp: 0 } });
  return { fsAdapter, versioning, sha };
}

// ---------------------------------------------------------------------------
// In-process git smart HTTP transport
//
// Implements the git smart HTTP protocol (Protocol v1) entirely in-process.
// Routes git-receive-pack and git-upload-pack requests to bare repo instances
// backed by HoplonFsAdapter + isomorphic-git.
//
// Protocol reference: https://git-scm.com/docs/http-protocol
// ---------------------------------------------------------------------------

/** Encode a single pkt-line line. */
function pktEncode(data: string | Uint8Array): Uint8Array {
  const payload = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const length = payload.length + 4;
  const hex = length.toString(16).padStart(4, '0');
  const prefix = new TextEncoder().encode(hex);
  const result = new Uint8Array(prefix.length + payload.length);
  result.set(prefix, 0);
  result.set(payload, prefix.length);
  return result;
}

/** The flush packet: `0000`. */
function pktFlush(): Uint8Array {
  return new TextEncoder().encode('0000');
}

/**
 * Collect an async iterable of Uint8Arrays into a single Buffer.
 */
async function collectBody(
  body: AsyncIterableIterator<Uint8Array> | undefined,
): Promise<Buffer> {
  if (body === undefined) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Parse a pkt-line stream buffer into an array of string lines.
 * Returns `null` for flush packets, and stops at EOF.
 */
function parsePktLines(buf: Buffer): string[] {
  const lines: string[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const lenHex = buf.slice(offset, offset + 4).toString('utf8');
    const length = parseInt(lenHex, 16);
    if (length === 0) {
      // flush packet — end of this section
      offset += 4;
      break;
    }
    const line = buf.slice(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
    lines.push(line);
    offset += length;
  }
  return lines;
}

/**
 * A "repo handle" for the in-process git smart HTTP server.
 * Wraps a HoplonFsAdapter + bare repo path.
 */
export interface InProcessRepoHandle {
  fsAdapter: HoplonFsAdapter;
  bareDir: string;
}

/**
 * Build and return an in-process HTTP transport that routes git smart HTTP
 * requests to a map of `url → InProcessRepoHandle` entries.
 *
 * Supports:
 *  - GET  {url}/info/refs?service=git-receive-pack
 *  - POST {url}/git-receive-pack
 *  - GET  {url}/info/refs?service=git-upload-pack
 *  - POST {url}/git-upload-pack
 *
 * Auth simulation:
 *  - If `rejectAuth` is true for a repo URL, the server returns HTTP 401,
 *    causing isomorphic-git to trigger onAuthFailure.
 */
export function createInProcessTransport(
  repos: Map<string, InProcessRepoHandle>,
  opts: { rejectAuth?: boolean } = {},
): HttpClient {
  return {
    async request({ url, method = 'GET', headers: _headers = {}, body }) {
      // Parse the URL to find which repo and which service
      const rejectAuth = opts.rejectAuth === true;
      if (rejectAuth) {
        return {
          url,
          statusCode: 401,
          statusMessage: 'Unauthorized',
          headers: { 'www-authenticate': 'Basic realm="git"' },
          body: toAsyncIterator([]),
        };
      }

      // Match: GET .../info/refs?service=git-{service}
      const infoRefsMatch = url.match(/^(.*?)\/info\/refs\?service=(git-(?:receive|upload)-pack)$/);
      if (infoRefsMatch !== null && method === 'GET') {
        const repoUrl = infoRefsMatch[1]!;
        const service = infoRefsMatch[2]!;
        const handle = repos.get(repoUrl);
        if (handle === undefined) {
          return { url, statusCode: 404, statusMessage: 'Not Found', body: toAsyncIterator([]) };
        }
        const responseBody = await buildInfoRefsResponse(handle, service);
        return {
          url,
          statusCode: 200,
          statusMessage: 'OK',
          headers: { 'content-type': `application/x-${service}-advertisement` },
          body: toAsyncIterator([responseBody]),
        };
      }

      // Match: POST .../git-receive-pack
      const receivePackMatch = url.match(/^(.*?)\/git-receive-pack$/);
      if (receivePackMatch !== null && method === 'POST') {
        const repoUrl = receivePackMatch[1]!;
        const handle = repos.get(repoUrl);
        if (handle === undefined) {
          return { url, statusCode: 404, statusMessage: 'Not Found', body: toAsyncIterator([]) };
        }
        const bodyBuf = await collectBody(body);
        const responseBody = await handleReceivePack(handle, bodyBuf);
        return {
          url,
          statusCode: 200,
          statusMessage: 'OK',
          headers: { 'content-type': 'application/x-git-receive-pack-result' },
          body: toAsyncIterator([responseBody]),
        };
      }

      // Match: POST .../git-upload-pack
      const uploadPackMatch = url.match(/^(.*?)\/git-upload-pack$/);
      if (uploadPackMatch !== null && method === 'POST') {
        const repoUrl = uploadPackMatch[1]!;
        const handle = repos.get(repoUrl);
        if (handle === undefined) {
          return { url, statusCode: 404, statusMessage: 'Not Found', body: toAsyncIterator([]) };
        }
        const bodyBuf = await collectBody(body);
        const responseBody = await handleUploadPack(handle, bodyBuf);
        return {
          url,
          statusCode: 200,
          statusMessage: 'OK',
          headers: { 'content-type': 'application/x-git-upload-pack-result' },
          body: toAsyncIterator([responseBody]),
        };
      }

      return { url, statusCode: 404, statusMessage: 'Not Found', body: toAsyncIterator([]) };
    },
  };
}

/** Convert an array of Buffers/Uint8Arrays to an async iterable iterator. */
async function* toAsyncIterator(chunks: (Uint8Array | Buffer)[]): AsyncIterableIterator<Uint8Array> {
  for (const chunk of chunks) {
    yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
  }
}

/**
 * Build the info/refs response for a service (git-receive-pack or git-upload-pack).
 *
 * Format (Protocol v1):
 *   pktline("# service={service}\n")
 *   flush
 *   pktline("{sha} {refname}\0{capabilities}\n")  // first ref (or empty-repo sentinel)
 *   pktline("{sha} {refname}\n")                   // subsequent refs
 *   flush
 */
async function buildInfoRefsResponse(
  handle: InProcessRepoHandle,
  service: string,
): Promise<Buffer> {
  const shim = createFsShim(handle.fsAdapter);
  const bareDir = handle.bareDir;

  // List all branches from the bare repo
  const branches = await git.listBranches({ fs: shim, dir: bareDir });
  const refs: Array<{ sha: string; ref: string }> = [];

  for (const branch of branches) {
    try {
      const sha = await git.resolveRef({ fs: shim, dir: bareDir, ref: branch });
      refs.push({ sha, ref: `refs/heads/${branch}` });
    } catch {
      // skip unresolvable refs
    }
  }

  // Resolve HEAD (needed by git-upload-pack so the client knows the default branch)
  let headSha: string | undefined;
  try {
    headSha = await git.resolveRef({ fs: shim, dir: bareDir, ref: 'HEAD' });
  } catch {
    // empty repo — no HEAD
  }

  const chunks: Uint8Array[] = [];

  // Service line + flush
  chunks.push(pktEncode(`# service=${service}\n`));
  chunks.push(pktFlush());

  // Capabilities string
  const caps = 'report-status side-band-64k delete-refs ofs-delta agent=hoplon-test';

  if (refs.length === 0) {
    // Empty repo: send capabilities-only sentinel
    const nullSha = '0000000000000000000000000000000000000000';
    chunks.push(pktEncode(`${nullSha} capabilities^\0${caps}\n`));
  } else {
    // First ref: HEAD ref with capabilities (git clients expect HEAD first)
    const first = refs[0]!;
    const headRef = headSha ?? first.sha;
    chunks.push(pktEncode(`${headRef} HEAD\0${caps} symref=HEAD:refs/heads/main\n`));
    // All refs/heads entries
    for (const r of refs) {
      chunks.push(pktEncode(`${r.sha} ${r.ref}\n`));
    }
  }
  chunks.push(pktFlush());

  return Buffer.concat(chunks);
}

/**
 * Handle a POST git-receive-pack request body.
 *
 * Protocol:
 *   request = pktline("{oldoid} {newoid} {refname}\0{caps}\n") ... flush [packdata]
 *   response = pktline("unpack ok\n") pktline("ok {refname}\n") ... flush
 */
async function handleReceivePack(
  handle: InProcessRepoHandle,
  bodyBuf: Buffer,
): Promise<Buffer> {
  const shim = createFsShim(handle.fsAdapter);
  const bareDir = handle.bareDir;

  // Parse the pkt-line update commands
  type RefUpdate = { oldoid: string; newoid: string; refname: string };
  const updates: RefUpdate[] = [];
  let offset = 0;

  while (offset < bodyBuf.length) {
    const lenHex = bodyBuf.slice(offset, offset + 4).toString('utf8');
    const length = parseInt(lenHex, 16);
    if (isNaN(length)) break;
    if (length === 0) {
      // flush — ref commands section ends, rest is packfile
      offset += 4;
      break;
    }
    const line = bodyBuf.slice(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
    // Strip capabilities (everything after \0)
    const cleanLine = line.split('\0')[0]!;
    const parts = cleanLine.split(' ');
    if (parts.length >= 3) {
      updates.push({
        oldoid: parts[0]!,
        newoid: parts[1]!,
        refname: parts[2]!,
      });
    }
    offset += length;
  }

  // The rest of the body (after the flush) is the packfile
  const packData = bodyBuf.slice(offset);

  // Write pack objects to the bare repo
  const updatedRefs: string[] = [];
  const errors: Map<string, string> = new Map();

  if (packData.length > 0) {
    try {
      // Write the packfile to a temp path in the bare repo's .git/objects/pack/
      const tempPackPath = `${bareDir}/.git/objects/pack/_incoming.pack`;
      await handle.fsAdapter.mkdir(`${bareDir}/.git/objects/pack`, { recursive: true });
      await handle.fsAdapter.write(tempPackPath, new Uint8Array(packData));

      // Index the pack (writes .idx file alongside .pack)
      await git.indexPack({
        fs: shim,
        dir: bareDir,
        filepath: `.git/objects/pack/_incoming.pack`,
      });
    } catch (err) {
      // Pack indexing failed — mark all refs as failed
      for (const u of updates) {
        errors.set(u.refname, `pack-index-failed: ${String(err)}`);
      }
    }
  }

  // Update refs for successful updates
  for (const update of updates) {
    if (errors.has(update.refname)) continue;
    try {
      const refPath = `${bareDir}/.git/${update.refname}`;
      // Ensure directory exists
      const refDir = refPath.substring(0, refPath.lastIndexOf('/'));
      await handle.fsAdapter.mkdir(refDir, { recursive: true });
      // Write the ref file: "{sha}\n"
      await handle.fsAdapter.write(
        refPath,
        new TextEncoder().encode(`${update.newoid}\n`),
      );
      updatedRefs.push(update.refname);
    } catch (err) {
      errors.set(update.refname, `ref-write-failed: ${String(err)}`);
    }
  }

  // Build the response using side-band-64k encoding.
  // The client requested 'side-band-64k' so ALL status lines must be wrapped
  // in side-band channel 1 (\x01 prefix) so that GitSideBand.demux routes
  // them to the 'packfile' FIFO, which parseReceivePackResponse reads from.
  const chunks: Uint8Array[] = [];

  // Build a side-band-64k wrapped pkt-line for channel 1 (pack data).
  // Structure: outer_pktline(\x01 + inner_pktline(text))
  // After GitSideBand.demux, the 'packfile' FIFO receives inner_pktline(text).
  // parseReceivePackResponse then uses GitPktLine.streamReader on the FIFO,
  // which correctly decodes inner_pktline(text) → text.
  function sideband1(text: string): Uint8Array {
    const innerPkt = pktEncode(text);            // pkt-line encoded text
    const wrapped = new Uint8Array(1 + innerPkt.length);
    wrapped[0] = 0x01;                            // side-band channel 1
    wrapped.set(innerPkt, 1);
    return pktEncode(wrapped);                   // outer pkt-line
  }

  chunks.push(sideband1('unpack ok\n'));
  for (const refname of updatedRefs) {
    chunks.push(sideband1(`ok ${refname}\n`));
  }
  for (const [refname, errMsg] of errors) {
    chunks.push(sideband1(`ng ${refname} ${errMsg}\n`));
  }
  chunks.push(pktFlush());

  return Buffer.concat(chunks);
}

/**
 * Walk all objects reachable from the given root OIDs (commits/tags).
 * Returns an array of all OIDs (commits + trees + blobs) reachable from roots.
 *
 * This is necessary because git.packObjects does NOT do a reachability walk —
 * it only packs the OIDs you explicitly pass. To pack a full upload-pack
 * response we need all reachable objects.
 */
async function walkReachableObjects(
  shim: ReturnType<typeof createFsShim>,
  dir: string,
  rootOids: string[],
): Promise<string[]> {
  const visited = new Set<string>();

  async function walk(oid: string): Promise<void> {
    if (visited.has(oid)) return;
    visited.add(oid);

    const result = await git.readObject({ fs: shim, dir, oid, format: 'parsed' });

    if (result.type === 'commit') {
      const commit = result.object as { tree: string; parent: string[] };
      await walk(commit.tree);
      for (const parentOid of (commit.parent ?? [])) {
        await walk(parentOid);
      }
    } else if (result.type === 'tree') {
      // TreeObject is TreeEntry[] where each entry has { oid, type }
      const tree = result.object as Array<{ oid: string; type: 'blob' | 'tree' | 'commit' }>;
      for (const entry of tree) {
        if (entry.type === 'blob' || entry.type === 'tree') {
          await walk(entry.oid);
        }
      }
    }
    // blobs: visited, no children to walk
  }

  for (const oid of rootOids) {
    await walk(oid);
  }
  return [...visited];
}

/**
 * Handle a POST git-upload-pack request body.
 *
 * Protocol:
 *   request = pktline("want {oid} {caps}\n") ... flush pktline("have {oid}\n") ... pktline("done\n")
 *   response = pktline("NAK\n") [side-band-64k packfile]
 *
 * We send NAK (no common ancestors) followed by the complete pack for wanted objects,
 * wrapped in side-band-64k format (byte \x01 prefix for pack data).
 */
async function handleUploadPack(
  handle: InProcessRepoHandle,
  bodyBuf: Buffer,
): Promise<Buffer> {
  const shim = createFsShim(handle.fsAdapter);
  const bareDir = handle.bareDir;

  // Parse the want lines from the request
  const wantedOids: string[] = [];
  const lines = parsePktLines(bodyBuf);
  for (const line of lines) {
    const cleanLine = line.split('\0')[0]!;
    if (cleanLine.startsWith('want ')) {
      wantedOids.push(cleanLine.slice('want '.length).trim());
    }
  }

  const chunks: Uint8Array[] = [];

  if (wantedOids.length === 0) {
    // Nothing wanted — just flush
    chunks.push(pktFlush());
    return Buffer.concat(chunks);
  }

  // NAK line (no common base)
  chunks.push(pktEncode('NAK\n'));

  // Walk all objects reachable from the wanted OIDs.
  // git.packObjects only packs what you explicitly pass (no reachability walk),
  // so we must enumerate commits + trees + blobs manually.
  try {
    const allOids = await walkReachableObjects(shim, bareDir, wantedOids);
    const { packfile } = await git.packObjects({
      fs: shim,
      dir: bareDir,
      oids: allOids,
      write: false,
    });

    if (packfile !== undefined && packfile.length > 0) {
      // Wrap pack data in side-band-64k format:
      // Each chunk: pktline(\x01 + chunkData)
      const CHUNK_SIZE = 32768; // 32KB chunks
      let pos = 0;
      while (pos < packfile.length) {
        const slice = packfile.slice(pos, Math.min(pos + CHUNK_SIZE, packfile.length));
        const sideband = new Uint8Array(slice.length + 1);
        sideband[0] = 0x01; // pack data channel
        sideband.set(slice, 1);
        chunks.push(pktEncode(sideband));
        pos += CHUNK_SIZE;
      }
    }
  } catch (_err) {
    // Pack failed — send error in side-band channel 3
    const errMsg = new TextEncoder().encode(`error packing objects\n`);
    const sideband = new Uint8Array(errMsg.length + 1);
    sideband[0] = 0x03; // error channel
    sideband.set(errMsg, 1);
    chunks.push(pktEncode(sideband));
  }

  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Test helpers for bare repo setup
// ---------------------------------------------------------------------------

/**
 * Create an empty bare git repo backed by a fresh memfs instance.
 * Returns the handle and a URL string to use as the remote.
 */
async function createBareRemote(url: string): Promise<{
  handle: InProcessRepoHandle;
  url: string;
}> {
  const fsAdapter = createMemFsAdapter();
  // isomorphic-git bare repos: the "dir" is the gitdir itself (no .git subdir),
  // but we use a non-bare init to keep things simple — init a regular repo at
  // bareDir with a .git/ subdirectory. The in-process server reads/writes .git/
  // directly.
  const bareDir = '/bare';
  const shim = createFsShim(fsAdapter);
  await git.init({ fs: shim, dir: bareDir, defaultBranch: 'main' });
  return { handle: { fsAdapter, bareDir }, url };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Remote git push/fetch (in-process transport)', () => {
  // -------------------------------------------------------------------------
  // 1. Push to local bare remote → remote HEAD advances
  // -------------------------------------------------------------------------
  it('1. push to local bare remote → remote refs/heads/main advances to pushed commit SHA', async () => {
    const remoteUrl = 'http://local.test/repo1';
    const { handle, url } = await createBareRemote(remoteUrl);
    const repos = new Map([[url, handle]]);
    const http = createInProcessTransport(repos);

    const { fsAdapter, sha } = await buildSourceRepo('/source');
    // Inject the in-process transport
    const vWithRemote = createIsomorphicGitVersioning({ fs: fsAdapter, http });

    await vWithRemote.push({ repoDir: '/source', remote: url, ref: 'main' });

    // Verify the bare remote now has the ref pointing to the pushed SHA
    const shim = createFsShim(handle.fsAdapter);
    const remoteHeadSha = await git.resolveRef({ fs: shim, dir: handle.bareDir, ref: 'refs/heads/main' });
    expect(remoteHeadSha).toBe(sha);
  });

  // -------------------------------------------------------------------------
  // 2. Fetch from local bare remote → remote-tracking ref updated
  // -------------------------------------------------------------------------
  it('2. fetch from local bare remote → refs/remotes/hoplon-origin/main points to remote commit', async () => {
    const remoteUrl = 'http://local.test/repo2';
    const { handle, url } = await createBareRemote(remoteUrl);

    // Set up a commit in the bare remote directly
    const bareShim = createFsShim(handle.fsAdapter);
    await handle.fsAdapter.write('/bare/file.txt', new TextEncoder().encode('remote content'));
    await git.add({ fs: bareShim, dir: '/bare', filepath: 'file.txt' });
    const remoteSha = await git.commit({
      fs: bareShim,
      dir: '/bare',
      message: 'commit on remote',
      author: { name: 'test', email: 'test@test.com', timestamp: 0, timezoneOffset: 0 },
      committer: { name: 'test', email: 'test@test.com', timestamp: 0, timezoneOffset: 0 },
    });

    const repos = new Map([[url, handle]]);
    const http = createInProcessTransport(repos);

    // Create a fresh empty local repo to fetch into
    const localFs = createMemFsAdapter();
    const localVersioning = createIsomorphicGitVersioning({ fs: localFs, http });
    await localVersioning.init('/local');

    await localVersioning.fetch({ repoDir: '/local', remote: url, ref: 'main' });

    // isomorphic-git writes the fetched ref to refs/remotes/hoplon-origin/<branch>
    // (based on the refspec set by git.addRemote: +refs/heads/*:refs/remotes/hoplon-origin/*)
    const localShim = createFsShim(localFs);
    const remoteTrackingRef = await git.resolveRef({
      fs: localShim,
      dir: '/local',
      ref: 'refs/remotes/hoplon-origin/main',
    });
    expect(remoteTrackingRef).toBe(remoteSha);
  });

  // -------------------------------------------------------------------------
  // 3. Push with auth failure → AdapterError({ kind: 'remote_push_failed' })
  // -------------------------------------------------------------------------
  it('3. push with auth failure (server returns 401) → AdapterError remote_push_failed', async () => {
    const remoteUrl = 'http://local.test/repo3';
    const { handle, url } = await createBareRemote(remoteUrl);
    const repos = new Map([[url, handle]]);
    // Use rejectAuth:true to simulate 401 from server
    const http = createInProcessTransport(repos, { rejectAuth: true });

    const { fsAdapter } = await buildSourceRepo('/source3');
    const vWithRemote = createIsomorphicGitVersioning({ fs: fsAdapter, http });

    const err = await vWithRemote
      .push({ repoDir: '/source3', remote: url, ref: 'main' })
      .catch(e => e);

    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).kind).toBe('remote_push_failed');
  });

  // -------------------------------------------------------------------------
  // 4. Round-trip: init bare → commit → push → fetch from second clone → same SHA
  // -------------------------------------------------------------------------
  it('4. round-trip: push then fetch from a second clone yields same SHA', async () => {
    const remoteUrl = 'http://local.test/repo4';
    const { handle, url } = await createBareRemote(remoteUrl);
    const repos = new Map([[url, handle]]);
    const http = createInProcessTransport(repos);

    // Push from source
    const { fsAdapter: sourceFs, sha: pushedSha } = await buildSourceRepo('/source4');
    const sourceVersioning = createIsomorphicGitVersioning({ fs: sourceFs, http });
    await sourceVersioning.push({ repoDir: '/source4', remote: url, ref: 'main' });

    // Fetch into a second clone
    const cloneFs = createMemFsAdapter();
    const cloneVersioning = createIsomorphicGitVersioning({ fs: cloneFs, http });
    await cloneVersioning.init('/clone');
    await cloneVersioning.fetch({ repoDir: '/clone', remote: url, ref: 'main' });

    // isomorphic-git writes the fetched ref to refs/remotes/hoplon-origin/<branch>
    // (based on the refspec set by git.addRemote: +refs/heads/*:refs/remotes/hoplon-origin/*)
    const cloneShim = createFsShim(cloneFs);
    const remoteTrackingRef = await git.resolveRef({
      fs: cloneShim,
      dir: '/clone',
      ref: 'refs/remotes/hoplon-origin/main',
    });
    expect(remoteTrackingRef).toBe(pushedSha);
  });

  // -------------------------------------------------------------------------
  // 5. disableRemote:true push → EngineError remote_not_supported
  // -------------------------------------------------------------------------
  it('5. disableRemote:true push → EngineError remote_not_supported', async () => {
    const fsAdapter = createMemFsAdapter();
    const versioning = createIsomorphicGitVersioning({ fs: fsAdapter, disableRemote: true });
    await versioning.init('/repo5');

    const err = await versioning
      .push({ repoDir: '/repo5', remote: 'https://example.com/repo.git', ref: 'main' })
      .catch(e => e);

    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).kind).toBe('remote_not_supported');
  });

  // -------------------------------------------------------------------------
  // 6. disableRemote:true fetch → EngineError remote_not_supported
  // -------------------------------------------------------------------------
  it('6. disableRemote:true fetch → EngineError remote_not_supported', async () => {
    const fsAdapter = createMemFsAdapter();
    const versioning = createIsomorphicGitVersioning({ fs: fsAdapter, disableRemote: true });
    await versioning.init('/repo6');

    const err = await versioning
      .fetch({ repoDir: '/repo6', remote: 'https://example.com/repo.git', ref: 'main' })
      .catch(e => e);

    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).kind).toBe('remote_not_supported');
  });

  // -------------------------------------------------------------------------
  // 7. Push network failure → AdapterError kind 'remote_push_failed'
  // -------------------------------------------------------------------------
  it('7. push to unreachable remote → AdapterError with kind remote_push_failed', async () => {
    // Transport that always throws a network error
    const brokenHttp: HttpClient = {
      request: async () => {
        throw new Error('ECONNREFUSED: simulated network failure');
      },
    };

    const fsAdapter = createMemFsAdapter();
    const versioning = createIsomorphicGitVersioning({ fs: fsAdapter, http: brokenHttp });
    await versioning.init('/repo7');
    await writeFile(fsAdapter, '/repo7/f.txt', 'content');
    await versioning.add('/repo7', ['f.txt']);
    await versioning.commit('/repo7', 'test commit');

    const err = await versioning
      .push({ repoDir: '/repo7', remote: 'http://unreachable.test/repo.git', ref: 'main' })
      .catch(e => e);

    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).kind).toBe('remote_push_failed');
  });

  // -------------------------------------------------------------------------
  // 8. Fetch network failure → AdapterError kind 'remote_fetch_failed'
  // -------------------------------------------------------------------------
  it('8. fetch from unreachable remote → AdapterError with kind remote_fetch_failed', async () => {
    const brokenHttp: HttpClient = {
      request: async () => {
        throw new Error('ECONNREFUSED: simulated network failure');
      },
    };

    const fsAdapter = createMemFsAdapter();
    const versioning = createIsomorphicGitVersioning({ fs: fsAdapter, http: brokenHttp });
    await versioning.init('/repo8');

    const err = await versioning
      .fetch({ repoDir: '/repo8', remote: 'http://unreachable.test/repo.git', ref: 'main' })
      .catch(e => e);

    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).kind).toBe('remote_fetch_failed');
  });
});
