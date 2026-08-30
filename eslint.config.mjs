import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import jsdoc from 'eslint-plugin-jsdoc'

/** Declarations that must be documented. */
const ALL_DECLARATIONS = [
  'FunctionDeclaration',
  'ClassDeclaration',
  'MethodDefinition',
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
]

export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', 'coverage/**', 'docs/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: { parser: tseslint.parser },
    plugins: { jsdoc },
    rules: {
      // The repo documents intent, not signatures: types already state the shape,
      // so a docblock that repeats them earns nothing. Require the comment and a
      // real description, and check any tags that are written, but never demand
      // @param/@returns boilerplate.
      'jsdoc/require-jsdoc': ['error', {
        publicOnly: false,
        require: {
          FunctionDeclaration: true,
          ClassDeclaration: true,
          MethodDefinition: true,
          ArrowFunctionExpression: true,
          FunctionExpression: true,
        },
        contexts: ALL_DECLARATIONS,
      }],
      'jsdoc/require-description': ['error', { contexts: ALL_DECLARATIONS }],
      'jsdoc/check-alignment': 'error',
      'jsdoc/check-param-names': 'error',
      'jsdoc/check-tag-names': 'error',
      'jsdoc/no-undefined-types': 'off',
      'jsdoc/empty-tags': 'error',
      'jsdoc/no-multi-asterisks': 'error',

      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      '@typescript-eslint/no-explicit-any': 'error',
      // Sanitising untrusted transcript text is this codebase's job: the control
      // and bidi ranges in these patterns are the point, not an accident.
      'no-control-regex': 'off',
      // Cleanup paths close and unlink on a best-effort basis. A failure there
      // must not mask the error being handled, so the empty catch is deliberate.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  {
    // Tests and one-off scripts are not a public surface, and they print by design.
    files: ['test/**/*.ts', 'test/**/*.tsx', 'scripts/**/*.ts'],
    rules: {
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/require-description': 'off',
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  {
    // The CLI writes to stdout: that is its output, not a stray debug print.
    files: ['src/cli.ts', 'src/commands/**/*.ts', 'src/render.ts'],
    rules: { 'no-console': 'off' },
  },
)
