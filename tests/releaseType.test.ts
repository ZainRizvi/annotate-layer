import { commitReleaseType, isValidTitle, releaseType, titleHelp } from '../scripts/release-type';

describe('commitReleaseType', () => {
  it.each([
    ['feat: add a theme prop', 'minor'],
    ['feat(lazy): retry on re-enable', 'minor'],
    ['fix: keep drafts after reload', 'patch'],
    ['perf(pins): fewer layout reads', 'patch'],
    ['feat!: rename the component', 'major'],
    ['fix(client)!: drop the cookie default', 'major'],
    ['refactor: split the sheet\n\nBREAKING CHANGE: AnnotateClient.list takes an object', 'major'],
    ['docs: clarify the contract', 'none'],
    ['ci: cache uv', 'none'],
    ['chore(deps): bump vitest', 'none'],
    ['test: cover the 404 path', 'none'],
    ['release: 1.2.0', 'none'],
    ['Merge branch main', 'none'],
  ])('%s → %s', (message, expected) => {
    expect(commitReleaseType(message)).toBe(expected);
  });

  it('ignores "BREAKING CHANGE" outside a footer line', () => {
    expect(commitReleaseType('docs: explain what counts as a BREAKING CHANGE: here')).toBe('none');
  });
});

describe('releaseType', () => {
  it('takes the largest bump across commits', () => {
    expect(releaseType(['docs: a', 'fix: b', 'feat: c'])).toBe('minor');
    expect(releaseType(['fix: a', 'feat!: b'])).toBe('major');
  });

  it('is none when nothing user-facing changed', () => {
    expect(releaseType([])).toBe('none');
    expect(releaseType(['ci: a', 'docs: b'])).toBe('none');
  });

  it('uses an exact version from a Release-As footer', () => {
    expect(releaseType(['fix: a', 'chore: cut 1.0\n\nRelease-As: 1.0.0'])).toBe('1.0.0');
    expect(releaseType(['docs: mention Release-As: 2.0.0 inline'])).toBe('none');
  });
});

describe('isValidTitle', () => {
  it.each(['feat: add x', 'fix(client): y', 'feat!: z', 'ci(publish)!: w'])('accepts %s', (t) => {
    expect(isValidTitle(t)).toBe(true);
  });

  it.each(['Rename stuff', 'fix:nospace', 'feature: x', 'feat(): x', 'release: 1.0.0'])('rejects %s', (t) => {
    expect(isValidTitle(t)).toBe(false);
  });

  it('lists every type in the help text', () => {
    expect(titleHelp()).toMatch(/feat\s+minor/);
    expect(titleHelp()).toMatch(/docs\s+no release/);
  });
});
