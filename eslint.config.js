import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'server/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // The layer depends on React, react-dom and the DOM only. Everything the host knows
    // comes in through props, so the package never reaches into a host app.
    files: ['src/**'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          regex: '^(?!react$|react-dom$|react/jsx-runtime$|\\./).*',
          message: 'The layer imports only react, react-dom and files inside src/.',
        }],
      }],
      'no-restricted-globals': ['error', {
        name: 'process',
        message: 'Take environment values from the host through props.',
      }],
    },
  },
  {
    files: ['tests/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off', '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
