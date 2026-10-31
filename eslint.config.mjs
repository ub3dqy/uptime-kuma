import { defineConfig, globalIgnores, includeIgnoreFile } from "eslint/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import vue from "eslint-plugin-vue";
import scoped from "eslint-plugin-vue-scoped-css";
import jsdoc from "eslint-plugin-jsdoc";
import ts from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import vueParser from "vue-eslint-parser";
import globals from "globals";
import prettier from "eslint-config-prettier";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig([
    includeIgnoreFile(path.join(__dirname, ".gitignore")),
    globalIgnores(["test/*.js", "server/modules/*", "src/util.js"]),
    js.configs.recommended,
    ...vue.configs["flat/recommended"],
    ...scoped.configs["flat/recommended"],
    {
        plugins: { jsdoc },
        rules: {
            "jsdoc/check-access": "error",
            "jsdoc/check-alignment": "error",
            "jsdoc/check-examples": "off",
            "jsdoc/check-indentation": "off",
            "jsdoc/check-line-alignment": "off",
            "jsdoc/check-param-names": "error",
            "jsdoc/check-property-names": "error",
            "jsdoc/check-syntax": "off",
            "jsdoc/check-tag-names": "error",
            "jsdoc/check-types": "error",
            "jsdoc/check-values": "error",
            "jsdoc/empty-tags": "error",
            "jsdoc/implements-on-classes": "error",
            "jsdoc/imports-as-dependencies": "off",
            "jsdoc/informative-docs": "off",
            "jsdoc/match-description": "off",
            "jsdoc/match-name": "off",
            "jsdoc/multiline-blocks": "error",
            "jsdoc/no-bad-blocks": "off",
            "jsdoc/no-blank-block-descriptions": "off",
            "jsdoc/no-blank-blocks": "off",
            "jsdoc/no-defaults": "error",
            "jsdoc/no-missing-syntax": "off",
            "jsdoc/no-multi-asterisks": "error",
            "jsdoc/no-restricted-syntax": "off",
            "jsdoc/no-types": "off",
            "jsdoc/no-undefined-types": "error",
            "jsdoc/require-asterisk-prefix": "off",
            "jsdoc/require-description": "off",
            "jsdoc/require-description-complete-sentence": "off",
            "jsdoc/require-example": "off",
            "jsdoc/require-file-overview": "off",
            "jsdoc/require-hyphen-before-param-description": "off",
            "jsdoc/require-jsdoc": "error",
            "jsdoc/require-param": "error",
            "jsdoc/require-param-description": "error",
            "jsdoc/require-param-name": "error",
            "jsdoc/require-param-type": "error",
            "jsdoc/require-property": "error",
            "jsdoc/require-property-description": "error",
            "jsdoc/require-property-name": "error",
            "jsdoc/require-property-type": "error",
            "jsdoc/require-returns": "error",
            "jsdoc/require-returns-check": "error",
            "jsdoc/require-returns-description": "error",
            "jsdoc/require-returns-type": "error",
            "jsdoc/require-throws": "off",
            "jsdoc/require-yields": "error",
            "jsdoc/require-yields-check": "error",
            "jsdoc/sort-tags": "off",
            "jsdoc/tag-lines": "error",
            "jsdoc/text-escaping": "off",
            "jsdoc/valid-types": "error",
        },
    },
    {
        languageOptions: {
            parser: vueParser,
            parserOptions: { parser: tsParser, sourceType: "module" },
            globals: { ...globals.browser, ...globals.node },
        },
        plugins: { "@typescript-eslint": ts },
        // Keep the existing review policy while upgrading the checker.
        rules: {
            "no-useless-assignment": "warn",
            "preserve-caught-error": "off",
            yoda: "error",
            eqeqeq: ["warn", "smart"],
            camelcase: [
                "warn",
                {
                    properties: "never",
                    ignoreImports: true,
                },
            ],
            "no-unused-vars": [
                "warn",
                {
                    args: "none",
                },
            ],
            "vue/max-attributes-per-line": "off",
            "vue/singleline-html-element-content-newline": "off",
            "vue/html-self-closing": "off",
            "vue/require-component-is": "off",
            "vue/attribute-hyphenation": "off",
            "vue/multi-word-component-names": "off",
            "vue-scoped-css/no-unused-selector": "warn",
            curly: "error",
            "no-var": "error",
            "no-throw-literal": "error",
            "no-constant-condition": [
                "error",
                {
                    checkLoops: false,
                },
            ],
            "no-extra-boolean-cast": "off",
            "no-unneeded-ternary": "error",
            "no-empty": [
                "error",
                {
                    allowEmptyCatch: true,
                },
            ],
            "no-control-regex": "off",
            "one-var": ["error", "never"],
            "max-statements-per-line": [
                "error",
                {
                    max: 1,
                },
            ],
            "jsdoc/check-tag-names": [
                "error",
                {
                    definedTags: ["link"],
                },
            ],
            "jsdoc/no-undefined-types": "off",
            "jsdoc/no-defaults": [
                "error",
                {
                    noOptionalParamNames: true,
                },
            ],
            "jsdoc/require-throws": "warn",
            "jsdoc/require-jsdoc": [
                "error",
                {
                    require: {
                        FunctionDeclaration: true,
                        MethodDefinition: true,
                    },
                },
            ],
            "jsdoc/no-blank-block-descriptions": "error",
            "jsdoc/require-returns-description": "warn",
            "jsdoc/require-returns-check": [
                "error",
                {
                    reportMissingReturnForUndefinedTypes: false,
                },
            ],
            "jsdoc/require-returns": [
                "warn",
                {
                    forceRequireReturn: true,
                    forceReturnsWithAsync: true,
                },
            ],
            "jsdoc/require-param-type": "warn",
            "jsdoc/require-param-description": "warn",
        },
    },
    {
        files: ["**/*.ts"],
        rules: {
            ...ts.configs.recommended.rules,
            ...{
                "jsdoc/require-returns-type": "off",
                "jsdoc/require-param-type": "off",
                "@typescript-eslint/no-explicit-any": "off",
                "@typescript-eslint/no-require-imports": "off",
                "prefer-const": "off",
            },
        },
    },
    prettier,
]);
