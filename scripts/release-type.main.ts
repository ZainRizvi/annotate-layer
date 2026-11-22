/**
 * Command line for the release rules: prints the release a commit log makes, or checks a PR title.
 * @actor CI workflow: checks PR titles and picks each release's version
 */
import { isValidTitle, releaseType, titleHelp } from './release-type.ts';

async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8');
  const chunks: string[] = [];
  for await (const chunk of process.stdin) if (typeof chunk === 'string') chunks.push(chunk);
  return chunks.join('');
}

const messagesOf = (log: string): string[] => log.split('\0').filter((m) => m.trim());

if (process.argv[2] === '--check-title') {
  if (!isValidTitle(process.argv[3] ?? '')) {
    console.error(titleHelp());
    process.exit(1);
  }
} else {
  console.log(releaseType(messagesOf(await readStdin())));
}
