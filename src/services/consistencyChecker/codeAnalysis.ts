// Code-side identifier analysis: language families, comment stripping,
// declaration patterns, and analyzer tiers.
import type { AnalyzerTier } from "../../types.js";

// Extensions with per-language declaration patterns.
const RELIABLE_ANALYZER_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".php",
  ".java",
]);

// Extensions on the generic heuristic path with smoke-test coverage.
const EXPERIMENTAL_ANALYZER_EXTENSIONS = new Set([".cs", ".go", ".rb", ".kt", ".rs"]);

export function analyzerTierForExtension(ext: string): AnalyzerTier {
  if (RELIABLE_ANALYZER_EXTENSIONS.has(ext)) {
    return "reliable";
  }
  if (EXPERIMENTAL_ANALYZER_EXTENSIONS.has(ext)) {
    return "experimental";
  }
  return "generic";
}

type LanguageFamily = "js" | "python" | "php" | "java" | "ruby" | "c";

export function familyForExtension(ext: string): LanguageFamily {
  switch (ext) {
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
    case ".ts":
    case ".tsx":
    case ".mts":
    case ".cts":
      return "js";
    case ".py":
      return "python";
    case ".php":
      return "php";
    case ".java":
      return "java";
    case ".rb":
      return "ruby";
    default:
      return "c";
  }
}

const C_LIKE_STRIP_SOURCE =
  "/\\*[\\s\\S]*?\\*/" +
  "|//[^\\n]*" +
  '|"(?:\\\\.|[^"\\\\\\n])*"' +
  "|'(?:\\\\.|[^'\\\\\\n])*'" +
  "|`(?:\\\\.|[^`\\\\])*`";
const PHP_STRIP_SOURCE = `${C_LIKE_STRIP_SOURCE}|#[^\\n]*`;
const RUBY_STRIP_SOURCE = `${C_LIKE_STRIP_SOURCE}|#[^\\n]*`; // Same `#` comments as PHP.
const PYTHON_STRIP_SOURCE =
  "'''[\\s\\S]*?'''" +
  '|"""[\\s\\S]*?"""' +
  "|#[^\\n]*" +
  '|"(?:\\\\.|[^"\\\\\\n])*"' +
  "|'(?:\\\\.|[^'\\\\\\n])*'";
export function stripCommentsAndStrings(content: string, family: LanguageFamily): string {
  let patternSource: string;
  if (family === "python") {
    patternSource = PYTHON_STRIP_SOURCE;
  } else if (family === "php") {
    patternSource = PHP_STRIP_SOURCE;
  } else if (family === "ruby") {
    patternSource = RUBY_STRIP_SOURCE;
  } else {
    patternSource = C_LIKE_STRIP_SOURCE;
  }
  return content.replace(new RegExp(patternSource, "g"), " ");
}

/** One side of an `X as Y` pair, normalized to a bare identifier or "". */
function takeAliasSide(part: string, side: "alias" | "original"): string {
  const halves = part.trim().split(/\s+as\s+/);
  return (side === "alias" ? halves.pop() : halves[0])?.trim() ?? "";
}

/** Add one comma-list item's alias and original names when they are identifiers. */
function addCommaListNames(target: Set<string>, name: string): void {
  for (const part of name.split(",")) {
    for (const side of ["alias", "original"] as const) {
      const candidate = takeAliasSide(part, side);
      if (/^[A-Za-z_$][\w$]*$/.test(candidate)) {
        target.add(candidate);
      }
    }
  }
}

function collectPatternMatches(target: Set<string>, stripped: string, pattern: RegExp): void {
  const matcher = new RegExp(pattern.source, pattern.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(stripped)) !== null) {
    for (let group = 1; group < match.length; group += 1) {
      const name = match[group];
      if (name) {
        addCommaListNames(target, name);
      }
    }
    if (match[0].length === 0) {
      matcher.lastIndex += 1;
    }
  }
}

/** Declaration patterns per language family; ruby/c have none (generic path). */
const FAMILY_PATTERNS: Record<LanguageFamily, RegExp[]> = {
  js: [
    /(?:^|[^\w$])(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g,
    /interface\s+([A-Za-z_$][\w$]*)/g,
    /enum\s+([A-Za-z_$][\w$]*)/g,
    /type\s+([A-Za-z_$][\w$]*)\s*[=<]/g,
    /(?:^|[^\w$])(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g,
    /(?:^|[^\w$])(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
    /export\s+default\s+class\s+([A-Za-z_$][\w$]*)/g,
    /export\s+default\s+function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
    /export\s*\{([^}]*)\}/g,
    /module\.exports\s*=\s*\{([^}]*)\}/g,
    /module\.exports\s*\.\s*([A-Za-z_$][\w$]*)\s*=/g,
    /module\.exports\s*=\s*([A-Za-z_$][\w$]*)/g,
  ],
  python: [/^[ \t]*class\s+([A-Za-z_]\w*)/gm, /^[ \t]*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm],
  php: [
    /(?:abstract\s+|final\s+|readonly\s+)*(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/g,
    /function\s+([A-Za-z_]\w*)\s*\(/g,
  ],
  java: [
    /(?:public\s+|protected\s+|private\s+|static\s+|final\s+|abstract\s+|sealed\s+|non-sealed\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/g,
    /@interface\s+([A-Za-z_]\w*)/g,
  ],
  ruby: [],
  c: [],
};

interface QualifiedNameSpec {
  pattern: RegExp;
  separator: string;
  keepFull: boolean;
}

/** Add a qualified name (PHP namespace, Java package) plus its last segment. */
function addQualifiedNames(target: Set<string>, stripped: string, spec: QualifiedNameSpec): void {
  const qualified = new Set<string>();
  collectPatternMatches(qualified, stripped, spec.pattern);
  for (const name of qualified) {
    if (spec.keepFull) target.add(name);
    const segments = name.split(spec.separator).filter((part) => part.length > 0);
    const last = segments[segments.length - 1];
    if (last) target.add(last);
  }
}

/** Declared identifiers per language family, found with plain patterns. */
export function extractDeclaredIdentifiers(stripped: string, family: LanguageFamily): Set<string> {
  const declared = new Set<string>();
  for (const pattern of FAMILY_PATTERNS[family]) {
    collectPatternMatches(declared, stripped, pattern);
  }
  if (family === "php") {
    addQualifiedNames(declared, stripped, {
      pattern: /namespace\s+([A-Za-z_\\][\w\\]*)\s*;/g,
      separator: "\\",
      keepFull: true,
    });
  } else if (family === "java") {
    addQualifiedNames(declared, stripped, {
      pattern: /package\s+([\w.]+)\s*;/g,
      separator: ".",
      keepFull: false,
    });
  }
  return declared;
}
