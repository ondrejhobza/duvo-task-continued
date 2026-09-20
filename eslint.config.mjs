import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Scratch: the runs' own workspaces, and the throwaway browser profile a
    // headless screenshot leaves behind. Both fill with third-party JavaScript
    // that has nothing to do with this project, and linting it buries the
    // findings that matter under thousands of warnings.
    ".runs/**",
    ".tmp-shots/**",
  ]),
]);

export default eslintConfig;
