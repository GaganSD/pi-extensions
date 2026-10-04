import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default [
  { ignores: ["**/node_modules/**", ".artifacts/**", ".pi/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,ts}"],
    languageOptions: { globals: { ...globals.node, ...globals.es2024 } },
    rules: {
      // Existing extension/test boundaries intentionally use dynamic Pi objects.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none",
        ignoreRestSiblings: true,
      }],
      "@typescript-eslint/no-empty-function": "off",
      // Terminal renderers deliberately recognize and strip ANSI/control bytes.
      "no-control-regex": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
];
