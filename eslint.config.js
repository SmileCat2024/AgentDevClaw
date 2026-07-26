import globals from 'globals';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  // ── Ignore build artifacts and dependencies ──────────────────
  {
    ignores: [
      'node_modules/**',
      'local-features/dist/**',
      'dist/**',
      'resources/**',
      'docs/**',
      '*.tgz',
      'test/_render-test.mjs',
      '.trash/**',
      '.agentdev/**',
      // Temporarily excluded: group-chat.js is under active refactoring
      'server/routes/group-chat.js',
      'server/routes/group-chat/**',
    ],
  },

  js.configs.recommended,

  // ── Common rules for all project JS ──────────────────────────
  // Only code-quality rules — no style/formatting rules here.
  // Formatting will be addressed incrementally to avoid massive diffs.
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // ── Correctness (error) ──────────────────────────────────
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      'no-undef': 'error',
      'no-redeclare': 'error',
      'no-unreachable': 'error',
      'no-fallthrough': 'error',
      'no-useless-rename': 'error',
      'no-useless-return': 'error',
      'no-self-assign': 'error',
      'no-self-compare': 'error',
      'no-shadow-restricted-names': 'error',
      'no-throw-literal': 'error',
      'no-useless-catch': 'error',
      'no-cond-assign': 'error',
      'no-inner-declarations': 'error',
      'no-irregular-whitespace': 'error',
      'no-mixed-spaces-and-tabs': 'error',
      'no-useless-escape': 'error',
      'no-useless-assignment': 'warn', // TODO: upgrade to 'error' after cleanup
      'preserve-caught-error': 'warn', // TODO: upgrade to 'error' after cleanup

      // ── Best practices (error) ───────────────────────────────
      'eqeqeq': ['error', 'smart'],
      'no-debugger': 'error',

      // ── Best practices (warn) ────────────────────────────────
      'no-var': 'warn',
      'prefer-const': 'off', // Too many false positives for mutable state vars
      'no-prototype-builtins': 'warn',
      'no-constant-condition': ['warn', { checkLoops: false }],
      'no-empty': 'warn', // TODO: upgrade to 'error' after clearing empty blocks
      'no-console': 'off',
    },
  },

  // ── Server-side files (Node.js) ──────────────────────────────
  {
    files: ['server/**/*.js', 'scripts/**/*.js', 'scripts/**/*.mjs', 'bin/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // ── Frontend files (browser) ─────────────────────────────────
  {
    files: ['public/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      'no-undef': 'off', // browser globals injected via HTML
      // Frontend modules share globals across <script> tags — cross-file
      // references (e.g. window.foo, inline onclick, frontend-vm test loads)
      // are invisible to ESLint. Disable unused-vars to avoid false positives.
      'no-unused-vars': 'off',
    },
  },

  // ── Test files ───────────────────────────────────────────────
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
    },
  },

  // ── MCP / prebuilt-agent config ──────────────────────────────
  {
    files: ['server/claw-mcp.js', 'prebuilt-agents/**/*.js'],
    rules: {
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
    },
  },

  // ── TypeScript files (local-features) ────────────────────────
  // Placed last so that TS-specific overrides win over common rules.
  // Scoped to .ts files only via files filter.
  ...tseslint.config(
    {
      files: ['local-features/**/*.ts'],
      extends: [...tseslint.configs.recommended],
      rules: {
        // Disable base rule — use @typescript-eslint equivalent instead
        'no-unused-vars': 'off',
        '@typescript-eslint/no-unused-vars': ['warn', {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        }],
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-require-imports': 'off',
        '@typescript-eslint/no-this-alias': 'warn', // TODO: upgrade to 'error' after cleanup
      },
    }
  ),
];
