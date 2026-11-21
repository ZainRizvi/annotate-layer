/**
 * Picks the semver bump for a release from the conventional-commit messages merged since the
 * last one:
 * - `type!:` or a `BREAKING CHANGE:` footer → major
 * - `feat:` → minor
 * - `fix:` or `perf:` → patch
 * - anything else (docs, ci, test, refactor, build, chore, style) → none, no release
 *
 * A `Release-As: x.y.z` footer overrides the bump with that exact version (for example the
 * first 1.0.0).
 *
 * CLI: `git log --format=%B%x00 <range> | node scripts/release-type.ts` prints the bump or version.
 */
import { pathToFileURL } from 'node:url';

export type ReleaseType = 'major' | 'minor' | 'patch' | 'none';
/** A bump, or an exact version from a `Release-As` footer. */
export type Release = ReleaseType | `${number}.${number}.${number}`;

const HEADER = /^(\w+)(\([^)]*\))?(!)?:/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/m;
const RELEASE_AS = /^Release-As:\s*v?(\d+\.\d+\.\d+)\s*$/im;
const RANK: Record<ReleaseType, number> = { none: 0, patch: 1, minor: 2, major: 3 };

export function commitReleaseType(message: string): ReleaseType {
  const header = HEADER.exec(message.trim());
  if (!header) return 'none';
  const [, type, , bang] = header;
  if (bang || BREAKING_FOOTER.test(message)) return 'major';
  if (type === 'feat') return 'minor';
  if (type === 'fix' || type === 'perf') return 'patch';
  return 'none';
}

export function releaseType(messages: string[]): Release {
  for (const m of messages) {
    const pinned = RELEASE_AS.exec(m);
    if (pinned) return pinned[1] as Release;
  }
  return messages.reduce<ReleaseType>((best, m) => {
    const t = commitReleaseType(m);
    return RANK[t] > RANK[best] ? t : best;
  }, 'none');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const messages = Buffer.concat(chunks).toString('utf8').split('\0').filter((m) => m.trim());
  console.log(releaseType(messages));
}
