// Compares entity names in a diagram (classes, components, interfaces)
// against identifiers in the codebase. A fast text heuristic, not a
// parser: it prefers real declarations but also accepts whole-word,
// case-insensitive, and filename matches. Results are evidence, not proof.

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
const MAX_FILE_SIZE_BYTES = 1_000_000; // Skip oversized generated files.
const MAX_EVIDENCE_MATCHED_FILES = 10; // Cap matched files per entity.

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

/** Reduce a raw diagram name to its plain identifier. */
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

/** Lowercase, separator-free form for lenient matching. */
function normalizeForMatch(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Candidate entity names from PlantUML source. */
function extractEntitiesFromPlantUml(source: string): string[] {
  const names = new Set<string>();
  const addClean = (raw: string | undefined): void => {
    if (!raw) return;
    const cleaned = cleanDiagramName(raw);
    if (cleaned) names.add(cleaned);
  };
  let match: RegExpExecArray | null;

  // Type declarations: class, interface, enum, record, struct, and friends.
  const declRegex =
    /^\s*(?:abstract\s+)?(?:class|interface|enum|record|struct|annotation|entity)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/gm;
  while ((match = declRegex.exec(source)) !== null) {
    names.add(match[1]);
  }

  // Aliased declarations (`class "Name" as Alias`).
  const aliasRegex =
    /^\s*(?:abstract\s+)?(?:class|interface|enum|record|struct|annotation|entity)\b[^\n{]*?\bas\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  while ((match = aliasRegex.exec(source)) !== null) {
    names.add(match[1]);
  }

  // Namespace/package/module blocks.
  const blockRegex = /^\s*(?:namespace|package|module)\s+([A-Za-z_][\w.\\/]*)/gm;
  while ((match = blockRegex.exec(source)) !== null) {
    addClean(match[1]);
  }

  // Components, with optional aliases.
  const componentRegex =
    /^\s*component\s+(?:\[([^\]]+)\]|"([^"]+)"|([A-Za-z_][\w.\\/]*))(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?/gm;
  while ((match = componentRegex.exec(source)) !== null) {
    addClean(match[1]);
    addClean(match[2]);
    addClean(match[3]);
    if (match[4]) names.add(match[4]);
  }

  // Sequence participants and actors, with optional aliases.
  const participantRegex =
    /^\s*(?:participant|actor|boundary|control|entity|database|collections|queue)\s+("[^"]+"|\[[^\]]+\]|\S+)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?/gm;
  while ((match = participantRegex.exec(source)) !== null) {
    addClean(match[1]);
    if (match[2]) names.add(match[2]);
  }

  // Message calls like `charge(card)`; plain labels are ignored.
  const messageCallRegex = /:(?![/:])[^\n:]*?\b([A-Za-z_][A-Za-z0-9_]{1,})\s*\(/g;
  while ((match = messageCallRegex.exec(source)) !== null) {
    addClean(match[1]);
  }

  return Array.from(names);
}

/** Candidate entity names from Mermaid source. */
function extractEntitiesFromMermaid(source: string): string[] {
  const names = new Set<string>();
  const addClean = (raw: string | undefined): void => {
    if (!raw) return;
    const cleaned = cleanDiagramName(raw);
    if (cleaned) names.add(cleaned);
  };
  let match: RegExpExecArray | null;

  // Class declarations.
  const classRegex = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  while ((match = classRegex.exec(source)) !== null) {
    names.add(match[1]);
  }

  // Annotations like `<<interface>> Name`.
  const annotationRegex = /<<\s*[^<>]*?>>\s*([A-Za-z_][A-Za-z0-9_]*)/gm;
  while ((match = annotationRegex.exec(source)) !== null) {
    names.add(match[1]);
  }

  // Namespace blocks.
  const namespaceRegex = /^\s*namespace\s+([A-Za-z_][\w.]*)/gm;
  while ((match = namespaceRegex.exec(source)) !== null) {
    addClean(match[1]);
  }

  // Sequence participants and actors, with optional aliases.
  const participantRegex =
    /^\s*(?:create\s+|destroy\s+)?(?:participant|actor)\s+("[^"]+"|\[[^\]]+\]|\S+)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?/gm;
  while ((match = participantRegex.exec(source)) !== null) {
    addClean(match[1]);
    if (match[2]) names.add(match[2]);
  }

  // C4 containers, components, systems, and people.
  const c4Regex =
    /\b(?:Container|Component|System|ExternalSystem|Person)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/g;
  while ((match = c4Regex.exec(source)) !== null) {
    names.add(match[1]);
  }

  // Subgraph groupings.
  const subgraphRegex = /^\s*subgraph\s+(?:"([^"]+)"|\[([^\]]+)\]|([A-Za-z_][\w-]*))/gm;
  while ((match = subgraphRegex.exec(source)) !== null) {
    addClean(match[1]);
    addClean(match[2]);
    addClean(match[3]);
  }

  // Message calls like `charge(card)`; plain labels are ignored.
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
const RUBY_STRIP_SOURCE = `${C_LIKE_STRIP_SOURCE}|#[^\\n]*`; // Same `#` comments as PHP.
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

/** Whole-word pattern for one name, plus its declaration-like usages. */
function buildDeclarationPattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Bare identifier as a whole word.
  return new RegExp(`\\b${escaped}\\b`);
}

interface ScannedFile {
  /** POSIX path relative to the searched directory. */
  relativePath: string;
  /** Lowercase file extension. */
  ext: string;
  stripped: string;
  normalized: string;
  declared: Set<string>;
  moduleName: string;
}

/** Indexes of scanned files matching one entity name. */
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
