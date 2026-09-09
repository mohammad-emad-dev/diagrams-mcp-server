// Minimal flat config: TypeScript recommended rules (no type-checking, so
// lint stays fast and hermetic), with prettier compat last to defer all
// stylistic decisions to Prettier. Scoped to src/ via the lint script;
// dist/, dependencies, and generated output are always ignored here.
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "graphify-out/**", "coverage/**"],
  },
  ...tseslint.configs.recommended,
  eslintConfigPrettier
);
