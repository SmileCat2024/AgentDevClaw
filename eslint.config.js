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
      // Untracked external projects in workspace root
      'json-render/**',
      'openui/**',
      'tambo/**',
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
      // window.ClawFW 下划线键是跨模块共享缓存的存储位，多处直写是历史
      // bug 温床（同一键多写方、失效语义不一致）。共享缓存必须收敛到唯一
      // owner 模块（参考 model-preset-cache.js / speech-config-cache.js），
      // 其他文件经导出的 getter / setter 访问。
      'no-restricted-syntax': ['error',
        {
          selector: "AssignmentExpression[left.type='MemberExpression'][left.computed=false][left.property.type='Identifier'][left.property.name=/^_/][left.object.type='MemberExpression'][left.object.computed=false][left.object.property.name='ClawFW']",
          message: '禁止直接写入 window.ClawFW 的下划线键。共享缓存请建 owner 模块（参考 model-preset-cache.js），经导出的 setter 写入。',
        },
      ],
    },
  },

  // 共享缓存 owner 模块：这些键的唯一写方，豁免上述限制。
  {
    files: [
      'public/src/modules/model-preset-cache.js',
      'public/src/modules/speech-config-cache.js',
    ],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },

  // Ratchet 清单：仍含存量 ClawFW 下划线键直写的前端文件（_speechEditing
  // 设置面板编辑态、_coderModelPresets 单文件内聚缓存）。随各域收敛从此
  // 清单移除；清单外新增直写直接报 error。
  {
    files: [
      'public/src/modules/model-settings.js',
      'public/src/modules/speech-settings.js',
      'public/src/modules/ph-project-actions.js',
    ],
    rules: {
      'no-restricted-syntax': 'warn',
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

  // ── Agent-side logging boundary ──────────────────────────────
  // Agent 运行时内部（feature 提供）的日志必须走 claw 日志体系：
  //   import { createLogger } from '@agentdevjs/core' → DebugHub → Web UI，
  //   无头运行时自动 fallback 到 stdio（分级 + stdout/stderr 分流）。
  // 进程内 console 桥只在 log scope 内生效，绕过 logger 的 console.*
  // 会丢失等级与命名空间，因此在此范围内禁止。
  // 非 agent 运行的日志（server/、scripts/、bin/、test/、public/）没有
  // 前端显示载体，console.log 是正当通道，保持 'no-console': 'off'。
  {
    files: ['prebuilt-agents/**/*.js', 'prebuilt-agents/**/*.mjs', 'local-features/**/*.ts'],
    rules: {
      'no-console': 'error',
    },
  },

  // Ratchet 清单：agent 侧仍含存量 console 的文件。迁移到 createLogger /
  // feature logger 后从此清单移除；清单外新增 console 直接报 error。
  // 注：.protoclaw-boot.mjs 属启动关键节点脚本，console 输出符合豁免原则，
  // 可长期保留在清单中。
  {
    files: [
      'prebuilt-agents/official/agent-creator/agent.js',
      'prebuilt-agents/official/flow-workspace/agent.js',
      'prebuilt-agents/official/programming-helper/.protoclaw-boot.mjs',
      'prebuilt-agents/official/programming-helper/agent.js',
      'prebuilt-agents/official/qqbot/agent.js',
      'local-features/dispatch/src/index.ts',
      'local-features/feature-dev/src/index.ts',
      'local-features/feature-wrappers/src/controlled-todo-feature.ts',
      'local-features/group-admin/src/bridge.ts',
    ],
    rules: {
      'no-console': 'warn',
    },
  },
];
