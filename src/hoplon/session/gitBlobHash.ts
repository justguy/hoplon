import { createHash } from 'node:crypto';

type Hex40 =
  `${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}${string}`;

export type GitBlobSha1 = `git-blob:sha1:${Hex40}`;

export function gitBlobSha1(bytes: Uint8Array): GitBlobSha1 {
  const header = `blob ${bytes.byteLength}\0`;
  const hash = createHash('sha1');
  hash.update(header, 'utf8');
  hash.update(bytes);
  return `git-blob:sha1:${hash.digest('hex')}` as GitBlobSha1;
}
