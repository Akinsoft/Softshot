import comments from "@eslint-community/eslint-plugin-eslint-comments";
import js from "@eslint/js";
import n from "eslint-plugin-n";
import promise from "eslint-plugin-promise";
import regexp from "eslint-plugin-regexp";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import sonarjs from "eslint-plugin-sonarjs";
import unicorn from "eslint-plugin-unicorn";
import unusedImports from "eslint-plugin-unused-imports";
import globals from "globals";
import tseslint from "typescript-eslint";

const sourceFiles = ["src/**/*.ts"];
const nodeFiles = ["src/main.ts", "src/preload.ts", "src/shared.ts"];
const browserFiles = ["src/overlay.ts", "src/recording-hud.ts", "src/global.d.ts"];
const importExtensions = [".ts", ".js", ".json", ".node"];

const maxComplexity = 25;
const maxLinesPerFunction = 100;
const maxNestedCallbacks = 3;
const maxStatements = 50;
const duplicateStringThreshold = 3;

function strictRules(...configs) {
  return Object.fromEntries(
    configs.flatMap((config) =>
      Object.entries(config.rules ?? {})
        .filter(([, setting]) => setting !== "off" && setting !== 0)
        .map(([rule, setting]) => [
          rule,
          setting === "warn" ? "error" : setting,
        ]),
    ),
  );
}

const pluginRules = strictRules(
  comments.configs.recommended,
  promise.configs["flat/recommended"],
  regexp.configs["flat/recommended"],
  sonarjs.configs.recommended,
  unicorn.configs["flat/recommended"],
);

const nodeRules = strictRules(n.configs["flat/recommended-module"]);

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/release/**",
      "**/.cache/**",
      "**/*.log",
    ],
  },
  {
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: "error",
      reportUnusedInlineConfigs: "error",
    },
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: sourceFiles,
    languageOptions: {
      ecmaVersion: "latest",
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      sourceType: "module",
    },
    plugins: {
      "@eslint-community/eslint-comments": comments,
      n,
      promise,
      regexp,
      "simple-import-sort": simpleImportSort,
      sonarjs,
      unicorn,
      "unused-imports": unusedImports,
    },
    rules: {
      ...pluginRules,
      "@eslint-community/eslint-comments/no-use": "error",
      "@typescript-eslint/array-type": ["error", { default: "array-simple" }],
      "@typescript-eslint/consistent-type-definitions": ["error", "interface"],
      "@typescript-eslint/explicit-function-return-type": [
        "error",
        {
          allowExpressions: false,
          allowHigherOrderFunctions: false,
          allowTypedFunctionExpressions: true,
        },
      ],
      "@typescript-eslint/no-confusing-void-expression": [
        "error",
        { ignoreArrowShorthand: true, ignoreVoidOperator: true },
      ],
      "@typescript-eslint/no-magic-numbers": [
        "error",
        {
          detectObjects: true,
          enforceConst: true,
          ignore: [-1, 0, 1],
          ignoreArrayIndexes: true,
          ignoreDefaultValues: false,
          ignoreEnums: false,
          ignoreNumericLiteralTypes: false,
          ignoreReadonlyClassProperties: false,
        },
      ],
      "@typescript-eslint/no-shadow": "error",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-use-before-define": [
        "error",
        {
          classes: true,
          functions: false,
          typedefs: true,
          variables: true,
        },
      ],
      "@typescript-eslint/prefer-readonly": "error",
      "@typescript-eslint/promise-function-async": "error",
      "@typescript-eslint/require-array-sort-compare": [
        "error",
        { ignoreStringArrays: false },
      ],
      "array-callback-return": ["error", { checkForEach: true }],
      "block-scoped-var": "error",
      complexity: ["error", maxComplexity],
      "consistent-return": "error",
      curly: ["error", "all"],
      "default-case": "error",
      "default-case-last": "error",
      "default-param-last": "error",
      eqeqeq: ["error", "always"],
      "func-name-matching": "error",
      "func-names": ["error", "as-needed"],
      "grouped-accessor-pairs": ["error", "getBeforeSet"],
      "guard-for-in": "error",
      "logical-assignment-operators": ["error", "always"],
      "max-classes-per-file": ["error", 1],
      "max-depth": "off",
      "max-len": [
        "error",
        {
          code: 140,
          comments: 140,
          ignoreComments: true,
          ignoreRegExpLiterals: true,
          ignoreStrings: true,
          ignoreTemplateLiterals: true,
          ignoreUrls: true,
        },
      ],
      "max-lines": "off",
      "max-lines-per-function": [
        "error",
        { max: maxLinesPerFunction, skipBlankLines: true, skipComments: true },
      ],
      "max-nested-callbacks": ["error", maxNestedCallbacks],
      "max-params": "off",
      "max-statements": ["error", maxStatements],
      "new-cap": ["error", { capIsNew: false }],
      "no-alert": "error",
      "no-array-constructor": "off",
      "no-bitwise": "error",
      "no-caller": "error",
      "no-case-declarations": "error",
      "no-console": "error",
      "no-div-regex": "error",
      "no-else-return": ["error", { allowElseIf: false }],
      "no-empty": ["error", { allowEmptyCatch: false }],
      "no-empty-function": "off",
      "no-eq-null": "error",
      "no-eval": "error",
      "no-extend-native": "error",
      "no-extra-bind": "error",
      "no-extra-label": "error",
      "no-implicit-coercion": "error",
      "no-implicit-globals": "error",
      "no-implied-eval": "off",
      "no-inline-comments": "error",
      "no-invalid-this": "error",
      "no-iterator": "error",
      "no-label-var": "error",
      "no-labels": "error",
      "no-lone-blocks": "error",
      "no-lonely-if": "error",
      "no-loop-func": "error",
      "no-multi-assign": "error",
      "no-negated-condition": "off",
      "no-nested-ternary": "error",
      "no-new": "error",
      "no-new-func": "error",
      "no-new-wrappers": "error",
      "no-object-constructor": "error",
      "no-octal-escape": "error",
      "no-param-reassign": "error",
      "no-promise-executor-return": "error",
      "no-proto": "error",
      "no-prototype-builtins": "error",
      "no-restricted-exports": [
        "error",
        { restrictedNamedExports: ["then"] },
      ],
      "no-restricted-globals": ["error", "event", "fdescribe", "fit"],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportNamespaceSpecifier",
          message: "Do not use wildcard imports; import the specific values you need.",
        },
      ],
      "no-return-assign": ["error", "always"],
      "no-script-url": "error",
      "no-self-compare": "error",
      "no-sequences": "error",
      "no-shadow": "off",
      "no-template-curly-in-string": "error",
      "no-throw-literal": "off",
      "no-undef": "off",
      "no-undef-init": "error",
      "no-undefined": "error",
      "no-unmodified-loop-condition": "error",
      "no-unneeded-ternary": "error",
      "no-unreachable-loop": "error",
      "no-unused-expressions": "off",
      "no-unused-private-class-members": "error",
      "no-unused-vars": "off",
      "no-useless-assignment": "error",
      "no-useless-call": "error",
      "no-useless-computed-key": "error",
      "no-useless-concat": "error",
      "no-useless-constructor": "off",
      "no-useless-escape": "error",
      "no-useless-rename": "error",
      "no-useless-return": "error",
      "no-var": "error",
      "no-void": "off",
      "no-warning-comments": "error",
      "object-shorthand": ["error", "always"],
      "one-var": ["error", "never"],
      "operator-assignment": ["error", "always"],
      "prefer-arrow-callback": ["error", { allowNamedFunctions: false }],
      "prefer-const": ["error", { destructuring: "all" }],
      "prefer-destructuring": [
        "error",
        {
          AssignmentExpression: {
            array: false,
            object: true,
          },
          VariableDeclarator: {
            array: false,
            object: true,
          },
        },
        { enforceForRenamedProperties: false },
      ],
      "prefer-exponentiation-operator": "error",
      "prefer-named-capture-group": "error",
      "prefer-numeric-literals": "error",
      "prefer-object-has-own": "error",
      "prefer-object-spread": "error",
      "prefer-promise-reject-errors": "off",
      "prefer-regex-literals": ["error", { disallowRedundantWrapping: true }],
      "prefer-rest-params": "error",
      "prefer-spread": "error",
      "prefer-template": "error",
      radix: ["error", "as-needed"],
      "require-atomic-updates": "off",
      "require-await": "off",
      "require-unicode-regexp": "error",
      "promise/always-return": "off",
      "promise/catch-or-return": "off",
      "sonarjs/cognitive-complexity": "off",
      "sonarjs/expression-complexity": ["error", { max: 6 }],
      "sonarjs/max-lines": "off",
      "sonarjs/max-lines-per-function": "off",
      "sonarjs/no-duplicate-string": [
        "error",
        { threshold: duplicateStringThreshold },
      ],
      "sonarjs/no-identical-functions": ["error", duplicateStringThreshold],
      "sonarjs/no-nested-functions": ["error", { threshold: 3 }],
      "sonarjs/regex-complexity": ["error", { threshold: 18 }],
      "simple-import-sort/exports": "error",
      "simple-import-sort/imports": [
        "error",
        {
          groups: [
            ["^node:"],
            ["^@?\\w"],
            ["^src(?:/.*|$)", "^@/(?:.*|$)", "^~(?:/.*|$)"],
            ["^\\u0000", "^\\."]
          ],
        },
      ],
      "sort-imports": "off",
      "symbol-description": "error",
      "unicode-bom": ["error", "never"],
      "unicorn/no-array-for-each": "off",
      "unicorn/no-null": "off",
      "unicorn/no-useless-undefined": "off",
      "unicorn/prefer-top-level-await": "off",
      "unicorn/consistent-boolean-name": [
        "error",
        {
          prefixes: {
            allows: true,
            needs: true,
            supports: true,
          },
        },
      ],
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "error",
        {
          args: "all",
          caughtErrors: "all",
          ignoreRestSiblings: false,
          vars: "all",
        },
      ],
      "vars-on-top": "error",
      yoda: ["error", "never"],
    },
  },
  {
    files: nodeFiles,
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...nodeRules,
      "n/no-missing-import": [
        "error",
        { tryExtensions: importExtensions },
      ],
      "n/no-unpublished-import": [
        "error",
        { tryExtensions: importExtensions },
      ],
    },
    settings: {
      n: {
        version: ">=24.0.0 <25.0.0",
      },
    },
  },
  {
    files: browserFiles,
    languageOptions: {
      globals: {
        ...globals.browser,
        RecordingHudController: "readonly",
      },
    },
  },
  {
    files: ["src/**/*.d.ts"],
    rules: {
      "@typescript-eslint/no-magic-numbers": "off",
      "unicorn/prevent-abbreviations": "off",
    },
  },
);
