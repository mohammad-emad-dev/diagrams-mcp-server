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

function collectPatternMatches(target: Set<string>, stripped: string, pattern: RegExp): void {
  const matcher = new RegExp(pattern.source, pattern.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(stripped)) !== null) {
    for (let group = 1; group < match.length; group += 1) {
      const name = match[group];
      if (name) {
        // Keep each identifier in comma lists like `export { A as B }`.
        for (const part of name.split(",")) {
          const alias =
            part
              .trim()
              .split(/\s+as\s+/)
              .pop()
              ?.trim() ?? "";
          if (/^[A-Za-z_$][\w$]*$/.test(alias)) {
            target.add(alias);
          }
          const original =
            part
              .trim()
              .split(/\s+as\s+/)[0]
              ?.trim() ?? "";
          if (/^[A-Za-z_$][\w$]*$/.test(original)) {
            target.add(original);
          }
        }
      }
    }
    if (match[0].length === 0) {
      matcher.lastIndex += 1;
    }
  }
}

/** Declared identifiers per language family, found with plain patterns. */
export function extractDeclaredIdentifiers(stripped: string, family: LanguageFamily): Set<string> {
  const declared = new Set<string>();
  if (family === "js") {
    collectPatternMatches(
      declared,
      stripped,
      /(?:^|[^\w$])(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g,
    );
    collectPatternMatches(declared, stripped, /interface\s+([A-Za-z_$][\w$]*)/g);
    collectPatternMatches(declared, stripped, /enum\s+([A-Za-z_$][\w$]*)/g);
    collectPatternMatches(declared, stripped, /type\s+([A-Za-z_$][\w$]*)\s*[=<]/g);
    collectPatternMatches(
      declared,
      stripped,
      /(?:^|[^\w$])(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g,
    );
    collectPatternMatches(
      declared,
      stripped,
      /(?:^|[^\w$])(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
    );
    collectPatternMatches(declared, stripped, /export\s+default\s+class\s+([A-Za-z_$][\w$]*)/g);
    collectPatternMatches(
      declared,
      stripped,
      /export\s+default\s+function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
    );
    collectPatternMatches(declared, stripped, /export\s*\{([^}]*)\}/g);
    collectPatternMatches(declared, stripped, /module\.exports\s*=\s*\{([^}]*)\}/g);
    collectPatternMatches(declared, stripped, /module\.exports\s*\.\s*([A-Za-z_$][\w$]*)\s*=/g);
    collectPatternMatches(declared, stripped, /module\.exports\s*=\s*([A-Za-z_$][\w$]*)/g);
  } else if (family === "python") {
    collectPatternMatches(declared, stripped, /^[ \t]*class\s+([A-Za-z_]\w*)/gm);
    collectPatternMatches(declared, stripped, /^[ \t]*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm);
  } else if (family === "php") {
    collectPatternMatches(
      declared,
      stripped,
      /(?:abstract\s+|final\s+|readonly\s+)*(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/g,
    );
    collectPatternMatches(declared, stripped, /function\s+([A-Za-z_]\w*)\s*\(/g);
    const namespaces = new Set<string>();
    collectPatternMatches(namespaces, stripped, /namespace\s+([A-Za-z_\\][\w\\]*)\s*;/g);
    for (const namespace of namespaces) {
      declared.add(namespace);
      const segments = namespace.split("\\").filter((part) => part.length > 0);
      const last = segments[segments.length - 1];
      if (last) declared.add(last);
    }
  } else if (family === "java") {
    collectPatternMatches(
      declared,
      stripped,
      /(?:public\s+|protected\s+|private\s+|static\s+|final\s+|abstract\s+|sealed\s+|non-sealed\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/g,
    );
    collectPatternMatches(declared, stripped, /@interface\s+([A-Za-z_]\w*)/g);
    const packages = new Set<string>();
    collectPatternMatches(packages, stripped, /package\s+([\w.]+)\s*;/g);
    for (const pack of packages) {
      const segments = pack.split(".").filter((part) => part.length > 0);
      const last = segments[segments.length - 1];
      if (last) declared.add(last);
    }
  }
  return declared;
}
