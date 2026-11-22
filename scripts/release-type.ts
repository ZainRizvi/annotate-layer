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
 * The command line lives in `release-type.main.ts`:
 *   git log --format=%B%x00 v1.2.3..HEAD | node scripts/release-type.main.ts   prints major|minor|patch|none|x.y.z
 *   node scripts/release-type.main.ts --check-title "a PR title"               exits 1 and lists the types
 */
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
const VERSION = /^\d+\.\d+\.\d+$/;
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

function isVersion(text: string): text is `${number}.${number}.${number}` {
  return VERSION.test(text);
}

/** The exact version a `Release-As` footer pins, if the message has one. */
function pinnedVersion(message: string): Release | undefined {
  const version = RELEASE_AS.exec(message)?.[1];
  return version !== undefined && isVersion(version) ? version : undefined;
}

export function releaseType(messages: string[]): Release {
  const pinned = messages.map(pinnedVersion).find((v) => v !== undefined);
  if (pinned) return pinned;
  return messages.reduce<ReleaseType>((best, m) => {
    const t = commitReleaseType(m);
    return RANK[t] > RANK[best] ? t : best;
  }, 'none');
}

export function titleHelp(): string {
  const rows = Object.entries(BUMP_BY_TYPE).map(
    ([type, bump]) => `  ${type.padEnd(9)}${bump === 'none' ? 'no release' : bump}`
  );
  return ['PR title: `type(scope)!: summary`. Scope is optional; `!` marks a breaking change (major).', ...rows].join('\n');
}
