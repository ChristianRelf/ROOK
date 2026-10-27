// Flat ESLint config for the whole workspace.
//
// Type-aware linting is enabled via typescript-eslint's project service, which
// resolves each file through the nearest tsconfig. That makes rules like
// no-floating-promises work, which matters a lot in a codebase full of pools,
// sockets and queues.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'apps/desktop/src-tauri/target/**',
      '**/*.d.ts',
    ],
  },

  js.configs.recommended,

  // Type-aware rules for all TypeScript sources.
  {
    files: ['**/*.{ts,tsx,mts}'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Unused values are usually a mistake, but an _-prefix is an explicit
      // "I know, this is here for the signature" marker.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // Swallowed rejections are the single most common source of silent
      // failure in long-running Node services.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      // Prefer explicit narrowing over assertions when crossing a boundary.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // `any` is banned, but we allow the escape hatch to be explicit.
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-syntax': [
        'error',
        {
          // Catches `catch {}` and `catch (e) {}` with an empty body.
          selector: 'CatchClause > BlockStatement:not(:has(*))',
          message:
            'Do not swallow errors. Log with context, rethrow, or document why the error is safe to drop.',
        },
      ],
    },
  },

  // Frontend-specific rules.
  //
  // `configs.flat` rather than `configs['recommended-latest']`: the latter is
  // still the eslintrc shape, whose `plugins` is an array of strings, which
  // flat config rejects outright.
  {
    files: ['apps/desktop/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    plugins: { 'react-refresh': reactRefresh },
    rules: {
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },

  // Tooling scripts and config files run outside the typed project graph.
  //
  // Without type information `no-undef` is the only thing checking globals, so
  // the Node ones are declared here. In type-checked files TypeScript does
  // this job and the rule is redundant.
  {
    files: ['**/*.{js,mjs,cjs}', '**/*.config.{ts,mts}', 'scripts/**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        crypto: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },

  // The desktop client has no log aggregator, so the browser console is where
  // diagnostics go. `log` stays banned to keep stray debugging out.
  {
    files: ['apps/desktop/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    rules: {
      'no-console': ['error', { allow: ['warn', 'error', 'debug'] }],
    },
  },

  // Tests get more latitude: fixtures legitimately use non-null assertions.
  {
    files: ['**/*.{test,spec}.{ts,tsx}', '**/tests/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      'no-console': 'off',
    },
  },
);
