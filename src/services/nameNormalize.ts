// Shared lenient name normalizer. Lowercases a name and removes every
// non-alphanumeric character, so "UserModel", "user-model", "user_model",
// and "USERMODEL" all collapse to one comparison key.
//
// Kept in its own module because two unrelated features depend on the same
// notion of "same name, written differently": the consistency checker uses
// it to match diagram entities against code identifiers, and diagrams_diff
// uses it to pair a removed name with an added one as a candidate rename.
// Importing it from one place keeps those two verdicts from drifting apart.

/**
 * Lowercase, separator-free form for lenient matching.
 * Returns the empty string for names that are separators or punctuation only;
 * callers must decide what an empty key means.
 */
export function normalizeForMatch(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}
