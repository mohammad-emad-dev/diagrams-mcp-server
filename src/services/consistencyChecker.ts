/**
 * consistencyChecker: best-effort, text-based comparison between the
 * entity names mentioned in a diagram (classes, components, interfaces)
 * and identifiers that actually exist in the codebase.
 *
 * This is intentionally NOT a full AST/semantic analysis. It is a fast,
 * dependency-free heuristic: extract candidate names from the diagram,
 * then look for matching declarations in the codebase. This catches the
 * most common drift (renamed/removed/never-implemented entities) without
 * requiring a language-specific parser per stack.
 *
 * What it can recognize:
 * - Diagram side (PlantUML): class/interface/enum/record/struct/annotation/
 *   entity declarations (with abstract, generics, and `as` aliases),
 *   namespace/package/module blocks, component `[..]`/`".."`/bare names
 *   (with aliases), sequence participant/actor/boundary/control/database
 *   declarations (with aliases), and sequence message calls (`name(...)`).
 * - Diagram side (Mermaid): class declarations, `<<annotation>>` names,
 *   namespace blocks, sequence participant/actor declarations (with `as`
 *   aliases and create/destroy), C4 Container/Component/System/Person keys,
 *   subgraph identifiers, and message calls (`name(...)`).
 * - Code side, reliable V1 languages: JavaScript/TypeScript
 *   (.js/.jsx/.mjs/.cjs/.ts/.tsx/.mts/.cts) classes, interfaces, enums,
 *   type aliases, functions, const/let/var bindings, export forms, React
 *   components (same declaration forms in JSX/TSX), and module basenames;
 *   Python (.py) classes and functions plus module basenames; PHP (.php)
 *   classes, interfaces, traits, enums, functions, and the last segment of
 *   namespaces; Java (.java) classes, interfaces, enums, records,
 *   annotations (@interface), and the last segment of packages.
 * - Other scanned extensions use a generic whole-word heuristic only.
 *   The experimental V1 languages (C#/.cs, Go/.go, Ruby/.rb, Kotlin/.kt,
 *   Rust/.rs) stay on this generic path: no per-language declaration
 *   patterns, just whole-word/normalized/basename matching after comment
 *   and string stripping. Ruby additionally strips `#` line comments;
 *   Ruby `=begin`/`=end` blocks and heredocs are not specially handled.
 *
 * What remains heuristic:
 * - Matching prefers real declarations but still falls back to a
 *   whole-word occurrence, a case/separator-insensitive comparison, and a
 *   file-basename (module) comparison, so an incidental reference can
 *   count as a match. Results are evidence, not a semantic verdict.
 * - Comments and quoted strings are stripped before matching, but template
 *   literal interpolations (`${...}`) are treated as string content and PHP
 *   heredoc/nowdoc blocks are not specially handled.
 * - Mermaid flowchart node ids and bare message labels without parentheses
 *   are not treated as entities (too noisy).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { toPosixPath } from "../constants.js";
import type {
  AnalyzerBreakdown,
  AnalyzerTier,
  ConsistencyCheckResult,
  ConsistencyEntityEvidence,
  ConsistencyIssue,
  DiagramType,
} from "../types.js";

const DEFAULT_IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  "target",
]);

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".java",
  ".cs",
  ".go",
  ".rb",
  ".php",
  ".kt",
  ".rs",
  ".swift",
  ".cpp",
  ".c",
  ".h",
  ".hpp",
]);

const MAX_FILES_SCANNED = 5000;
const MAX_FILE_SIZE_BYTES = 1_000_000; // skip unusually large files (generated/minified)
// Cap per-entity matched files in structured output so evidence stays bounded.
const MAX_EVIDENCE_MATCHED_FILES = 10;

// Extensions with per-language declaration patterns (see module docstring).
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

// Extensions on the generic whole-word heuristic path that are covered by
// experimental smoke tests (must not be presented as reliable).
const EXPERIMENTAL_ANALYZER_EXTENSIONS = new Set([".cs", ".go", ".rb", ".kt", ".rs"]);

function analyzerTierForExtension(ext: string): AnalyzerTier {
  if (RELIABLE_ANALYZER_EXTENSIONS.has(ext)) {
    return "reliable";
  }
  if (EXPERIMENTAL_ANALYZER_EXTENSIONS.has(ext)) {
    return "experimental";
  }
  return "generic";
}

const HEURISTIC_WARNING =
  "Heuristic text matching only: matching prefers declarations but falls back " +
  "to whole-word occurrence, case/separator-insensitive comparison, and " +
  "file-basename comparison, so an incidental reference can count as a match. " +
  "Treat results as evidence, not a definitive verdict.";

const SCAN_TRUNCATED_WARNING =
  "Scan reached the 5,000-file limit and stopped early; unmatched results may be incomplete. " +
  "Narrow the scanned directory or split the check to complete verification.";

/** Clean a raw diagram name: unquote, drop generics, keep the last qualified segment. */
function cleanDiagramName(raw: string): string | null {
  let name = raw.trim();
  if (name.length === 0) return null;
  if (
    (name.startsWith('"') && name.endsWith('"')) ||
    (name.startsWith("'") && name.endsWith("'")) ||
    (name.startsWith("[") && name.endsWith("]"))
  ) {
    name = name.slice(1, -1).trim();
  }
  if (name.length === 0) return null;
  const suffixStart = name.search(/[<~(]/);
  if (suffixStart > 0) {
    name = name.slice(0, suffixStart).trim();
  }
  const parenStart = name.indexOf("(");
  if (parenStart > 0) {
    name = name.slice(0, parenStart).trim();
  }
  if (name.length === 0) return null;
  const segments = name
    .split(/[/\\.:]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const last = segments[segments.length - 1] ?? "";
  return last.length > 0 ? last : null;
}

/** Case/separator-insensitive form used as a secondary (heuristic) comparison. */
function normalizeForMatch(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Extract plausible entity names (classes, interfaces, components) from PlantUML. */
function extractEntitiesFromPlantUml(source: string): string[] {
  const names = new Set<string>();
  const addClean = (raw: string | undefined): void => {
    if (!raw) return;
    const cleaned = cleanDiagramName(raw);
    if (cleaned) names.add(cleaned);
  };
  let match: RegExpExecArray | null;

  // class Foo, interface Foo, abstract class Foo, enum Foo, record Foo
  const declRegex =
    /^\s*(?:abstract\s+)?(?:class|interface|enum|record|struct|annotation|entity)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/gm;
  while ((match = declRegex.exec(source)) !== null) {
    names.add(match[1]);
  }

  // class "Spaced Name" as Alias (and other declaration aliases)
  const aliasRegex =
    /^\s*(?:abstract\s+)?(?:class|interface|enum|record|struct|annotation|entity)\b[^\n{]*?\bas\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  while ((match = aliasRegex.exec(source)) !== null) {
    names.add(match[1]);
  }

  // namespace App.Models / package shop / module billing
  const blockRegex = /^\s*(?:namespace|package|module)\s+([A-Za-z_][\w.\\/]*)/gm;
  while ((match = blockRegex.exec(source)) !== null) {
    addClean(match[1]);
  }

  // component [Foo], component "Foo", component Foo (+ optional `as Alias`)
  const componentRegex =
    /^\s*component\s+(?:\[([^\]]+)\]|"([^"]+)"|([A-Za-z_][\w.\\/]*))(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?/gm;
  while ((match = componentRegex.exec(source)) !== null) {
    addClean(match[1]);
    addClean(match[2]);
    addClean(match[3]);
    if (match[4]) names.add(match[4]);
  }

  // participant Foo / actor "Old Name" as NewName (sequence diagrams)
  const participantRegex =
    /^\s*(?:participant|actor|boundary|control|entity|database|collections|queue)\s+("[^"]+"|\[[^\]]+\]|\S+)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?/gm;
  while ((match = participantRegex.exec(source)) !== null) {
    addClean(match[1]);
    if (match[2]) names.add(match[2]);
  }

  // Sequence message calls: `Alice -> Bob : charge(card)` (ignores plain labels)
  const messageCallRegex = /:(?![/:])[^\n:]*?\b([A-Za-z_][A-Za-z0-9_]{1,})\s*\(/g;
  while ((match = messageCallRegex.exec(source)) !== null) {
    addClean(match[1]);
  }

  return Array.from(names);
}

/** Extract plausible entity names from Mermaid class/flow/component-ish diagrams. */
function extractEntitiesFromMermaid(source: string): string[] {
  const names = new Set<string>();
  const addClean = (raw: string | undefined): void => {
    if (!raw) return;
    const cleaned = cleanDiagramName(raw);
    if (cleaned) names.add(cleaned);
  };
  let match: RegExpExecArray | null;

  // classDiagram: "class Foo {" or "class Foo"
  const classRegex = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  while ((match = classRegex.exec(source)) !== null) {
    names.add(match[1]);
  }

  // classDiagram annotations: "<<interface>> Foo"
  const annotationRegex = /<<\s*[^<>]*?>>\s*([A-Za-z_][A-Za-z0-9_]*)/gm;
  while ((match = annotationRegex.exec(source)) !== null) {
    names.add(match[1]);
  }

  // classDiagram namespaces: "namespace shop {"
  const namespaceRegex = /^\s*namespace\s+([A-Za-z_][\w.]*)/gm;
  while ((match = namespaceRegex.exec(source)) !== null) {
    addClean(match[1]);
  }

  // sequenceDiagram: "participant Foo", "actor Bar", "A as Alice", "create participant C"
  const participantRegex =
    /^\s*(?:create\s+|destroy\s+)?(?:participant|actor)\s+("[^"]+"|\[[^\]]+\]|\S+)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?/gm;
  while ((match = participantRegex.exec(source)) !== null) {
    addClean(match[1]);
    if (match[2]) names.add(match[2]);
  }

  // C4 diagrams: Container(api, ...) / Component(list, ...) / Person(user, ...)
  const c4Regex =
    /\b(?:Container|Component|System|ExternalSystem|Person)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/g;
  while ((match = c4Regex.exec(source)) !== null) {
    names.add(match[1]);
  }

  // Flowchart groupings: "subgraph Billing"
  const subgraphRegex = /^\s*subgraph\s+(?:"([^"]+)"|\[([^\]]+)\]|([A-Za-z_][\w-]*))/gm;
  while ((match = subgraphRegex.exec(source)) !== null) {
    addClean(match[1]);
    addClean(match[2]);
    addClean(match[3]);
  }

  // Sequence message calls: "A->>B: charge(card)" (ignores plain labels)
  const messageCallRegex = /:(?![/:])[^\n:]*?\b([A-Za-z_][A-Za-z0-9_]{1,})\s*\(/g;
  while ((match = messageCallRegex.exec(source)) !== null) {
    addClean(match[1]);
  }

  return Array.from(names);
}

export function extractEntities(source: string, type: DiagramType): string[] {
  return type === "plantuml"
    ? extractEntitiesFromPlantUml(source)
    : extractEntitiesFromMermaid(source);
}

type LanguageFamily = "js" | "python" | "php" | "java" | "ruby" | "c";

function familyForExtension(ext: string): LanguageFamily {
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
// Ruby: C-like comments/strings plus `#` line comments (mirrors the PHP approach).
const RUBY_STRIP_SOURCE = `${C_LIKE_STRIP_SOURCE}|#[^\\n]*`;
const PYTHON_STRIP_SOURCE =
  "'''[\\s\\S]*?'''" +
  '|"""[\\s\\S]*?"""' +
  "|#[^\\n]*" +
  '|"(?:\\\\.|[^"\\\\\\n])*"' +
  "|'(?:\\\\.|[^'\\\\\\n])*'";
function stripCommentsAndStrings(content: string, family: LanguageFamily): string {
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
        // `export { A as B }` / `module.exports = { A, B }` lists: keep each identifier.
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

/** Declaration-like identifiers per language family (heuristic regexes, no parser). */
function extractDeclaredIdentifiers(stripped: string, family: LanguageFamily): Set<string> {
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

async function collectCodeFiles(
  rootDir: string,
  maxFiles: number,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;

  const walk = async (dir: string): Promise<void> => {
    if (files.length >= maxFiles) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory, skip
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) {
          continue;
        }
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (CODE_EXTENSIONS.has(ext)) {
          files.push(path.join(dir, entry.name));
        }
      }
    }
  };

  await walk(rootDir);
  if (files.length >= maxFiles) {
    truncated = true;
  }
  return { files, truncated };
}

/** Build a regex that matches common "declaration-like" usages of a name. */
function buildDeclarationPattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Matches: class Name / interface Name / def Name / struct Name / type Name
  // or the bare identifier as a whole word (fallback, catches functions,
  // records, data classes, etc. across languages without per-language parsing).
  return new RegExp(`\\b${escaped}\\b`);
}

interface ScannedFile {
  /** POSIX path relative to the searched directory (evidence only, never contents). */
  relativePath: string;
  /** Lowercase file extension, used for analyzer-tier classification. */
  ext: string;
  stripped: string;
  normalized: string;
  declared: Set<string>;
  moduleName: string;
}

/**
 * Indexes into `scanned` whose file matches `entity`. The predicate is the
 * unchanged V1 matching logic; returning indexes instead of a boolean only
 * lets callers report *which* files matched as evidence.
 */
function findMatchingFileIndexes(entity: string, scanned: ScannedFile[]): number[] {
  const normalizedEntity = normalizeForMatch(entity);
  const pattern = buildDeclarationPattern(entity);
  const matched: number[] = [];
  for (let index = 0; index < scanned.length; index += 1) {
    const file = scanned[index];
    if (file.declared.has(entity)) {
      matched.push(index);
      continue;
    }
    if (file.moduleName === entity) {
      matched.push(index);
      continue;
    }
    if (
      normalizedEntity.length > 0 &&
      file.moduleName.length > 0 &&
      normalizeForMatch(file.moduleName) === normalizedEntity
    ) {
      matched.push(index);
      continue;
    }
    pattern.lastIndex = 0;
    if (pattern.test(file.stripped)) {
      matched.push(index);
      continue;
    }
    if (normalizedEntity.length > 0 && file.normalized.includes(` ${normalizedEntity} `)) {
      matched.push(index);
    }
  }
  return matched;
}

export async function checkConsistency(
  diagramRelativePath: string,
  diagramSource: string,
  diagramType: DiagramType,
  codeRootDir: string,
): Promise<ConsistencyCheckResult> {
  const entities = extractEntities(diagramSource, diagramType);
  const { files: codeFiles, truncated } = await collectCodeFiles(codeRootDir, MAX_FILES_SCANNED);

  const scanned: ScannedFile[] = [];
  for (const file of codeFiles) {
    try {
      const stat = await fs.stat(file);
      if (stat.size > MAX_FILE_SIZE_BYTES) continue;
      const raw = await fs.readFile(file, "utf-8");
      const ext = path.extname(file).toLowerCase();
      const family = familyForExtension(ext);
      const stripped = stripCommentsAndStrings(raw, family);
      scanned.push({
        relativePath: toPosixPath(path.relative(codeRootDir, file)),
        ext,
        stripped,
        normalized: ` ${stripped.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `,
        declared: extractDeclaredIdentifiers(stripped, family),
        moduleName: path.basename(file, ext),
      });
    } catch {
      // unreadable file (permissions, race condition); skip it
    }
  }

  const analyzers: AnalyzerBreakdown = {
    reliable: [],
    experimental: [],
    generic: [],
  };
  const seenExtensions: Record<AnalyzerTier, Set<string>> = {
    reliable: new Set(),
    experimental: new Set(),
    generic: new Set(),
  };
  for (const file of scanned) {
    const tier = analyzerTierForExtension(file.ext);
    if (!seenExtensions[tier].has(file.ext)) {
      seenExtensions[tier].add(file.ext);
      analyzers[tier].push(file.ext);
    }
  }
  for (const tier of Object.keys(analyzers) as AnalyzerTier[]) {
    analyzers[tier].sort();
  }

  const issues: ConsistencyIssue[] = [];
  const evidence: ConsistencyEntityEvidence[] = [];
  const matchedEntities: string[] = [];
  const unmatchedEntities: string[] = [];
  let matched = 0;

  for (const entity of entities) {
    const matchIndexes = findMatchingFileIndexes(entity, scanned);
    const isMatched = matchIndexes.length > 0;
    if (isMatched) {
      matched++;
      matchedEntities.push(entity);
    } else {
      unmatchedEntities.push(entity);
      issues.push({
        name: entity,
        issue: `'${entity}' appears in the diagram but no matching identifier was found in the scanned codebase. It may be renamed, removed, or not yet implemented.`,
        severity: "warning",
      });
    }
    const matchedTiers = [
      ...new Set(matchIndexes.map((index) => analyzerTierForExtension(scanned[index].ext))),
    ].sort();
    const allMatchedFiles = matchIndexes.map((index) => scanned[index].relativePath);
    evidence.push({
      name: entity,
      matched: isMatched,
      analyzers: matchedTiers,
      matchedFiles: allMatchedFiles.slice(0, MAX_EVIDENCE_MATCHED_FILES),
      matchedFileCount: allMatchedFiles.length,
    });
  }

  return {
    diagramPath: diagramRelativePath,
    entitiesFound: entities.length,
    entitiesMatched: matched,
    entitiesUnmatched: entities.length - matched,
    issues,
    searchedDirectory: codeRootDir,
    filesScanned: scanned.length,
    truncated,
    scanLimit: MAX_FILES_SCANNED,
    scanWarning: truncated ? SCAN_TRUNCATED_WARNING : null,
    entities: [...entities],
    matchedEntities,
    unmatchedEntities,
    analyzers,
    confidence: "heuristic",
    heuristicWarning: HEURISTIC_WARNING,
    evidence,
  };
}
