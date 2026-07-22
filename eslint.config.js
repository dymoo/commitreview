import js from '@eslint/js';
import globals from 'globals';
import jsdoc from 'eslint-plugin-jsdoc';
import prettier from 'eslint-config-prettier';

/**
 * This project ships plain ESM JavaScript with no build step, so the checks that
 * a compiler would normally provide have to be assembled explicitly:
 *
 *   eslint      correctness and modern-JS discipline
 *   jsdoc       the type annotations are JSDoc, so they must themselves be valid
 *   tsc         --checkJs reads those annotations and type-checks against them
 *   prettier    formatting, which eslint-config-prettier keeps eslint out of
 *
 * Rules here are chosen to catch bugs, not to enforce taste. Anything Prettier
 * already decides is deliberately absent.
 */
export default [
  js.configs.recommended,
  jsdoc.configs['flat/recommended'],
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // Correctness.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-implicit-coercion': ['error', { boolean: false }],
      'no-return-await': 'error',
      'require-atomic-updates': 'error',
      'no-constant-binary-expression': 'error',
      'no-self-compare': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-promise-executor-return': 'error',
      'no-template-curly-in-string': 'error',
      'array-callback-return': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],

      // An empty catch is how a swallowed failure becomes a mystery. Allow it
      // only where the comment says why it is safe.
      'no-empty': ['error', { allowEmptyCatch: false }],

      // Modern JS.
      'prefer-arrow-callback': 'error',
      'prefer-template': 'error',
      'object-shorthand': ['error', 'properties'],
      'prefer-object-spread': 'error',
      'no-useless-concat': 'error',
      'symbol-description': 'error',

      // JSDoc is this project's type system, so it has to be well formed —
      // but not mandatory on every function, which would be noise.
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/require-param-description': 'off',
      'jsdoc/require-returns-description': 'off',
      'jsdoc/require-returns': 'off',
      'jsdoc/require-param': 'off',
      'jsdoc/tag-lines': 'off',
      // JSDoc IS the type system here — tsc --checkJs reads it — so @typedef,
      // @type and @property are load-bearing, not redundant.
      'jsdoc/check-tag-names': ['error', { typed: false }],
      'jsdoc/reject-any-type': 'off',
      'jsdoc/require-property-description': 'off',
      'jsdoc/require-returns-type': 'off',
      'jsdoc/require-param-type': 'off',
      'jsdoc/escape-inline-tags': 'off',
      'jsdoc/no-undefined-types': 'off',
      'jsdoc/valid-types': 'error',
      'jsdoc/check-types': 'error',
      'jsdoc/check-param-names': 'error',
      'jsdoc/check-alignment': 'error',
      'jsdoc/empty-tags': 'error',
    },
  },
  {
    // Tests reach into internals and assert on shapes; the source rules that
    // exist to protect production behaviour do not all apply.
    files: ['test/**/*.js'],
    rules: {
      'jsdoc/valid-types': 'off',
      'no-empty': 'off',
    },
  },
  {
    ignores: ['node_modules/**'],
  },
  prettier,
];
