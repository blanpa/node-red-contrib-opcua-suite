"use strict";

/**
 * ESLint flat config (ESLint 9).
 *
 * The repo previously declared a `lint` script but shipped no config at all, so
 * `npm run lint` failed with "ESLint couldn't find a configuration file" — the
 * quality gate never actually ran. The glob also only covered `lib/*.js`, which
 * silently skipped `lib/transports/`.
 */

const js = require("@eslint/js");

module.exports = [
  {
    ignores: [
      "node_modules/**",
      "data/**",
      "logs/**",
      "examples/**",
      "coverage/**",
    ],
  },

  js.configs.recommended,

  // ── Runtime + test sources ──
  {
    files: ["nodes/**/*.js", "lib/**/*.js", "test/**/*.js", "test-server/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "writable",
        exports: "writable",
        process: "readonly",
        Buffer: "readonly",
        console: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        clearImmediate: "readonly",
        URL: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        AbortSignal: "readonly",
        AbortController: "readonly",
        WeakSet: "readonly",
      },
    },
    rules: {
      "no-unused-vars": [
        "error",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^(_|e$|err$|error$)",
        },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-console": "warn",
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "prefer-const": "warn",
    },
  },

  // ── Tests: mock signatures routinely ignore positional parameters ──
  {
    files: ["test/**/*.js", "test-server/**/*.js"],
    languageOptions: {
      globals: {
        describe: "readonly",
        it: "readonly",
        before: "readonly",
        after: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
      "no-console": "off",
    },
  },
];
