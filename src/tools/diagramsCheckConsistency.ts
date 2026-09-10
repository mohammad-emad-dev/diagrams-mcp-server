import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { toPosixPath } from "../constants.js";
import { checkConsistency } from "../services/consistencyChecker/index.js";
import { handleToolError } from "./toolError.js";

const InputSchema = z
  .object({
    relative_path: z
      .string()
      .min(1)
      .describe("Path to the diagram to check, relative to the diagrams root."),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

export function registerDiagramsCheckConsistency(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "diagrams_check_consistency",
    {
      title: "Check Diagram-to-Code Consistency",
      description: `Compare class/interface/component names mentioned in a PlantUML or Mermaid diagram against identifiers that actually exist in the codebase, to catch documentation drift.

This is a heuristic, text-based check (not a full semantic/AST analysis): it extracts entity names from class/interface/enum/component declarations in the diagram, then searches source files under the project root for a matching identifier as a whole word. It flags names that appear in the diagram but were not found anywhere in the scanned code — a signal the diagram may be outdated, or the code was renamed/removed/not yet built.

This tool does NOT modify the diagram or the code. It only reports findings; the caller (agent or human) decides what to do about them.

Args:
  - relative_path (string): Path to the diagram to check, relative to the diagrams root

Returns:
  JSON with schema:
  {
    "diagram_path": string,
    "entities_found": number,      // total entity names extracted from the diagram
    "entities_matched": number,    // how many were found somewhere in the code
    "entities_unmatched": number,  // how many were NOT found (potential drift)
    "files_scanned": number,       // how many source files were searched
    "searched_directory": string,  // absolute path of the code root that was scanned
    "truncated": boolean,          // true when the 5,000-file scan cap was reached; unmatched results may be incomplete
    "scan_limit": number,          // maximum source files collected during the scan
    "scan_warning": string | null, // human-readable warning when truncated, otherwise null
    "entities": string[],          // extracted entity names, in extraction order
    "matched_entities": string[],  // extracted entities found in the code
    "unmatched_entities": string[],// extracted entities NOT found (potential drift)
    "analyzers": {                 // scanned file extensions per analyzer tier
      "reliable": string[],        // per-language declaration patterns (JS/TS, Python, PHP, Java)
      "experimental": string[],    // generic heuristic path (C#, Go, Ruby, Kotlin, Rust)
      "generic": string[]          // other scanned extensions, heuristic path only
    },
    "confidence": "heuristic",     // results are evidence, never a definitive verdict
    "heuristic_warning": string,   // human-readable limits of the heuristic
    "evidence": [                  // per-entity evidence, same order as "entities"
      {
        "name": string,
        "matched": boolean,
        "analyzers": ("reliable" | "experimental" | "generic")[],
        "matched_files": string[], // POSIX paths relative to searched_directory (capped)
        "matched_file_count": number
      }
    ],
    "issues": [
      {
        "name": string,           // the unmatched entity name
        "issue": string,          // human-readable explanation
        "severity": "warning" | "info"
      }
    ]
  }

Examples:
  - Use when: "Is this class diagram still accurate compared to the code?" -> relative_path="models/user-class.puml"
  - Use when: Reviewing a PR that touches architecture, to check the UML docs weren't left behind
  - Don't use when: The diagram has no class/interface/component declarations (e.g. a pure sequence diagram) — entities_found will be 0, which is expected, not an error

Error Handling:
  - Returns "Error: No diagram found at '<path>'" if the diagram file doesn't exist
  - An empty "issues" array with entities_found=0 means no checkable entities were found in the diagram, not that everything matched
  - Unexpected internal failures return a generic "Error: Unexpected internal error ..." with isError:true and are logged to stderr without source, paths, or secrets`,
      inputSchema: InputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: Input) => {
      try {
        const { content, type } = await ctx.diagramStore.read(params.relative_path);
        const result = await checkConsistency(params.relative_path, content, type, ctx.codeRootDir);

        const displayPath = toPosixPath(params.relative_path);
        const output = {
          diagram_path: toPosixPath(result.diagramPath),
          entities_found: result.entitiesFound,
          entities_matched: result.entitiesMatched,
          entities_unmatched: result.entitiesUnmatched,
          files_scanned: result.filesScanned,
          searched_directory: result.searchedDirectory,
          truncated: result.truncated,
          scan_limit: result.scanLimit,
          scan_warning: result.scanWarning,
          entities: result.entities,
          matched_entities: result.matchedEntities,
          unmatched_entities: result.unmatchedEntities,
          analyzers: result.analyzers,
          confidence: result.confidence,
          heuristic_warning: result.heuristicWarning,
          evidence: result.evidence.map((entry) => ({
            name: entry.name,
            matched: entry.matched,
            analyzers: entry.analyzers,
            matched_files: entry.matchedFiles,
            matched_file_count: entry.matchedFileCount,
          })),
          issues: result.issues,
        };

        const truncationNote =
          result.truncated && result.scanWarning ? ` Warning: ${result.scanWarning}` : "";
        const summaryText =
          result.entitiesFound === 0
            ? `No checkable class/interface/component names found in '${displayPath}'.${truncationNote}`
            : result.issues.length === 0
              ? `All ${result.entitiesFound} entities in '${displayPath}' were found in the codebase (${result.filesScanned} files scanned). No drift detected.${truncationNote}`
              : `${result.issues.length} of ${result.entitiesFound} entities in '${displayPath}' were NOT found in the codebase:\n` +
                result.issues.map((i) => `- ${i.name}: ${i.issue}`).join("\n") +
                truncationNote;

        return {
          content: [{ type: "text" as const, text: summaryText }],
          structuredContent: output,
        };
      } catch (err: unknown) {
        return handleToolError("diagrams_check_consistency", err);
      }
    },
  );
}
