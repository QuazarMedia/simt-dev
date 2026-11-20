// The one lint the repo runs for import hygiene: an import nobody reads is
// drift, the same class of defect test/deadcode.test.mjs guards on the export
// side. ESLint is a devDependency on purpose - it runs in a checkout, never in
// the shipped bytes, so ADR-012's zero-runtime-dependency rule is untouched.
// The zero-install guard is test/unused-imports.test.mjs; this config exists
// so the bulk fix (`npm run lint:imports`) is precise rather than textual.

import unusedImports from 'eslint-plugin-unused-imports';

export default [
  {
    files: ['**/*.mjs'],
    ignores: ['node_modules/**', 'dist/**', '.simt/**'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { 'unused-imports': unusedImports },
    rules: {
      'unused-imports/no-unused-imports': 'error',
    },
  },
];
