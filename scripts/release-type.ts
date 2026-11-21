/**
 * The release rules: how a commit title maps to a semver bump. This file is the only place they
 * are defined. CI checks PR titles against it, and the publish workflow picks each release's
 * version with it.
 *
 * A title is a conventional-commit header, `type(scope)?!?: summary`, using a type from
 * `BUMP_BY_TYPE`. `!` after the type, or a `BREAKING CHANGE:` footer, makes it a major release. A
 * release takes the largest bump among the commits merged since the last tag; `none` everywhere
 * means no release. A `Release-As: x.y.z` footer sets that exact version instead.
 *
 * CLI:
 *   git log --format=%B%x00 v1.2.3..HEAD | node scripts/release-type.ts   → major|minor|patch|none|x.y.z
 *   node scripts/release-type.ts --check-title "<PR title>"              → exits 1 and lists the types
 */
import { pathToFileURL } from 'node:url';

export type ReleaseType = 'major' | 'minor' | 'patch' | 'none';
/** A bump, or an exact version from a `Release-As` footer. */
export type Release = ReleaseType | `${number}.${number}.${number}`;

export const BUMP_BY_TYPE = {
  feat: 'minor',
  fix: 'patch',
  perf: 'patch',
  docs: 'none',
  test: 'none',
  refactor: 'none',
  build: 'none',
  ci: 'none',
  chore: 'none',
  style: 'none',
  revert: 'none',
} as const satisfies Record<string, ReleaseType>;

const HEADER = /^(\w+)(\([^)]+\))?(!)?: \S/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/m;
const RELEASE_AS = /^Release-As:\s*v?(\d+\.\d+\.\d+)\s*$/im;
const RANK: Record<ReleaseType, number> = { none: 0, patch: 1, minor: 2, major: 3 };

function knownType(type: string): type is keyof typeof BUMP_BY_TYPE {
  return Object.hasOwn(BUMP_BY_TYPE, type);
}

export function isValidTitle(title: string): boolean {
  const header = HEADER.exec(title);
  return !!header && knownType(header[1]);
}

export function commitReleaseType(message: string): ReleaseType {
  const header = HEADER.exec(message.trim());
  if (!header || !knownType(header[1])) return 'none';
  if (header[3] || BREAKING_FOOTER.test(message)) return 'major';
  return BUMP_BY_TYPE[header[1]];
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

export function titleHelp(): string {
  const rows = Object.entries(BUMP_BY_TYPE).map(
    ([type, bump]) => `  ${type.padEnd(9)}${bump === 'none' ? 'no release' : bump}`
  );
  return [
    'A PR title must be `type: summary` or `type(scope): summary`. Types and the release each makes:',
    ...rows,
    'Add `!` after the type (`feat!: …`) for a breaking change: a major release.',
    'Rules: scripts/release-type.ts',
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--check-title') {
    const title = process.argv[3] ?? '';
    if (!isValidTitle(title)) {
      console.error(`Not a valid PR title: ${JSON.stringify(title)}\n\n${titleHelp()}`);
      process.exit(1);
    }
  } else {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const messages = Buffer.concat(chunks).toString('utf8').split('\0').filter((m) => m.trim());
    console.log(releaseType(messages));
  }
}
