import { describe, it, expect } from 'vitest';
import path from 'path';
import { ESLint } from 'eslint';

/**
 * The layer's independence is enforced by the ESLint rules for `src/**`. These
 * checks run that config, so removing or loosening the rule fails here as well
 * as in `npm run lint`.
 */
const eslint = new ESLint({ cwd: path.resolve(__dirname, '..') });

async function ruleIds(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.map((m) => m.ruleId ?? 'fatal');
}

describe('module boundary', () => {
  it('rejects host-app, framework and icon-library imports inside src', async () => {
    for (const source of ['@/contexts', 'next/navigation', 'next', '../config', 'lucide-react']) {
      const ids = await ruleIds(`import x from '${source}';\nexport default x;\n`, 'src/probe.ts');
      expect(ids, source).toContain('no-restricted-imports');
    }
  }, 30_000);

  it('rejects process.env inside src', async () => {
    const ids = await ruleIds('export const env = process.env.X;\n', 'src/probe.ts');
    expect(ids).toContain('no-restricted-globals');
  });

  it('allows React, react-dom and sibling files', async () => {
    const code =
      "import React from 'react';\nimport { createPortal } from 'react-dom';\nimport { cssPath } from './picker';\nexport { React, createPortal, cssPath };\n";
    expect(await ruleIds(code, 'src/probe.ts')).toEqual([]);
  });
});
