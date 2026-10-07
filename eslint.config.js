// ESLint:只開「真的會出錯」的規則(未定義變數、未使用變數、重複宣告…),不管排版風格。
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['vendor/**', 'node_modules/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'sw.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.serviceworker },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['tests/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: { 'no-unused-vars': ['error', { args: 'none', ignoreRestSiblings: true }] },
  },
];
