import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { MAX_SEQUENCE_MESSAGES, MAX_SEQUENCE_PARTICIPANTS, toPosixPath } from "../constants.js";
import type { GenerateDeps } from "../services/generate/collectEntities.js";
import { collectSequence } from "../services/generate/sequence.js";
import { MAX_SCAN_FILES } from "../services/consistencyChecker/scanning.js";
import { validateDiagramSource } from "../services/diagramValidator.js";
import { resolveScope } from "../services/scopeResolve.js";
import { handleToolError } from "./toolError.js";

const InputSchema = z
  .object({
    scope: z
      .string()
      .min(1)
      .default(".")
      .describe(
        "Relative path under the project root pointing at a file or a directory to read " +
          "(default: '.', the whole project root). Absolute paths and anything that resolves " +
          "outside the project root are refused.",
      ),
    format: z
      .enum(["puml", "mermaid"])
      .default("puml")
      .describe("Output dialect for the generated sequence diagram (default: 'puml')."),
    max_participants: z
      .number()
      .int()
      .min(1)
      .max(MAX_SEQUENCE_PARTICIPANTS)
      .default(8)
      .describe(
        `Hard cap on declared participants, an integer between 1 and ${MAX_SEQUENCE_PARTICIPANTS} (default: 8). ` +
          `The applied cap is reported as participant_limit; anything past it is counted in participants_available ` +
          `and flagged by participants_capped.`,
      ),
    max_messages: z
      .number()
      .int()
      .min(1)
      .max(MAX_SEQUENCE_MESSAGES)
      .default(20)
      .describe(
        `Hard cap on emitted messages, an integer between 1 and ${MAX_SEQUENCE_MESSAGES} (default: 20). ` +
          `The applied cap is reported as message_limit; messages past it, or to a participant the participant cap ` +
          `removed, are counted in messages_available and flagged by messages_capped.`,
      ),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

// Exported so tests can parse arguments exactly as the server does: the SDK
// runs safeParse on the input schema before the handler sees the arguments,
// which is what applies the defaults above.
export const diagramsGenerateSequenceInputSchema = InputSchema;

const HEURISTIC_WARNING =
  "Static call-site order is not runtime order: messages are emitted in the order the reader met " +
  "the call, which says nothing about what happens at run time. A call inside a callback, promise, " +
  "or listener is unknowable from source and is counted in deferred_count instead of being sequenced. " +
  "Participant mapping is declared-identifier equality only — there is no type resolution, so a callee " +
  "no file in the scope declares is listed in unresolved_callees rather than attached to a guessed " +
  "participant. Message arguments, cross-language calls, and dynamic dispatch are out of scope. Treat " +
  "the result as a draft to review, then save it with diagrams_create.";

/** Map the wire dialect to the store's diagram type. */
function diagramTypeFor(format: "puml" | "mermaid"): "plantuml" | "mermaid" {
  return format === "puml" ? "plantuml" : "mermaid";
}

export function registerDiagramsGenerateSequence(
  server: McpServer,
  ctx: ServerContext,
  deps: GenerateDeps = {},
): void {
  server.registerTool(
    "diagrams_generate_sequence",
    {
      title: "Generate a Sequence Diagram from Code",
      description: `Draft a PlantUML or Mermaid sequence diagram from the message-call patterns in a slice of the codebase, returning source text to review and then save with diagrams_create.

Static call-site order is not runtime order. This tool reads call sites in the order a reader meets them and says so in every result: a call inside a callback, promise, or listener is counted in deferred_count and excluded from the messages, because its real position in the conversation is unknowable from source.

It is the generative flip side of the consistency checker's ordered call graph: the same caller-to-callee evidence, turned into a starter diagram instead of a verdict. It never writes: nothing lands in the diagrams directory without an explicit diagrams_create call.

Participant mapping is declared-identifier equality only — a callee that no file in the scope declares is reported in unresolved_callees, never attached to an invented participant. Which class owns a method is a type question, and out of scope.

Args:
  - scope (string, default "."): Relative path under the project root pointing at a file or a directory. Absolute paths and anything resolving outside the project root are refused
  - format ('puml' | 'mermaid', default 'puml'): Output dialect
  - max_participants (integer 1-${MAX_SEQUENCE_PARTICIPANTS}, default 8): Hard cap on declared participants
  - max_messages (integer 1-${MAX_SEQUENCE_MESSAGES}, default 20): Hard cap on emitted messages

Returns:
  JSON with schema:
  {
    "scope": string,                 // POSIX path as resolved, "." for the project root
    "format": "puml" | "mermaid",
    "source": string,                // the generated sequence; identical to the text block
    "participants": string[],        // participant names as emitted, in first-conversation order, capped
    "participants_included": number, // length of "participants"
    "participants_available": number,// distinct participants in candidate messages, may exceed the cap
    "participants_capped": boolean,  // true when participants were dropped by the cap
    "participant_limit": number,     // the applied cap (max_participants, at most ${MAX_SEQUENCE_PARTICIPANTS})
    "messages": [                    // ordered call sites, one per sequenced call
      { "from": string, "to": string, "message": string, "line": number, "via_callback": false }
    ],
    "messages_included": number,
    "messages_available": number,    // candidate messages, may exceed the cap
    "messages_capped": boolean,      // true when messages were dropped by either cap
    "message_limit": number,         // the applied cap (max_messages, at most ${MAX_SEQUENCE_MESSAGES})
    "deferred_count": number,        // call sites inside callbacks/promises: counted, never sequenced
    "unresolved_callees": string[],  // callees no participant in the scope declares
    "files_scanned": number,
    "truncated": boolean,            // true when the ${MAX_SCAN_FILES.toLocaleString()}-file scan cap was reached
    "scan_limit": number,            // ${MAX_SCAN_FILES.toLocaleString()}
    "scan_warning": string | null,   // human-readable warning when truncated, otherwise null
    "confidence": "heuristic",
    "heuristic_warning": string,     // what static call order can and cannot tell you
    "written": false                 // always false; save with diagrams_create
  }

  Every cap reports itself in-band, so a truncated or capped result is never silent.

Examples:
  - Use when: "Show the call flow between the checkout and payment modules" -> scope="src/checkout"
  - Use when: "Draft a Mermaid sequence for this service layer" -> scope="src/services", format="mermaid"
  - Don't use when: You need runtime ordering, async semantics, or which class a method belongs to (out of scope; deferred and unresolved calls are reported instead)
  - Don't use when: You want a class diagram (use diagrams_generate) or a hand-written skeleton (write the source directly)

Error Handling:
  - Returns "Error: Refused to resolve scope outside the project root: '<scope>'" when scope is absolute or resolves outside the project root; no file is read
  - A scope with no code files is not an error: participants and messages are empty, and the emitted source is a valid empty diagram
  - Emitted source always passes the same syntax gate diagrams_create enforces; an emission that cannot is reported as an unexpected internal error
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
        // Resolve the scope before any read: a refusal must touch no file.
        const scope = resolveScope(ctx.codeRootDir, params.scope);

        // The schema already bounds both inputs at their MAX_* ceilings; the
        // clamp keeps that invariant honest if the two ever drift apart.
        const participantLimit = Math.min(params.max_participants, MAX_SEQUENCE_PARTICIPANTS);
        const messageLimit = Math.min(params.max_messages, MAX_SEQUENCE_MESSAGES);

        const collected = await collectSequence(scope.absolutePath, {
          format: params.format,
          maxParticipants: participantLimit,
          maxMessages: messageLimit,
          deps,
        });

        const diagramType = diagramTypeFor(params.format);
        // Self-check: the emitted source must clear the same gate
        // diagrams_create enforces, so the output can be saved as-is.
        validateDiagramSource(collected.source, diagramType);

        const output = {
          scope: toPosixPath(scope.relativePath),
          format: params.format,
          source: collected.source,
          participants: collected.participants,
          participants_included: collected.participants.length,
          participants_available: collected.participantsAvailable,
          participants_capped: collected.participantsDropped > 0,
          participant_limit: participantLimit,
          messages: collected.messages,
          messages_included: collected.messages.length,
          messages_available: collected.messagesAvailable,
          messages_capped: collected.messagesDropped > 0,
          message_limit: messageLimit,
          deferred_count: collected.deferredCount,
          unresolved_callees: collected.unresolvedCallees,
          files_scanned: collected.filesScanned,
          truncated: collected.truncated,
          scan_limit: collected.scanLimit,
          scan_warning: collected.scanWarning,
          confidence: "heuristic" as const,
          heuristic_warning: HEURISTIC_WARNING,
          written: false as const,
        };

        return {
          content: [{ type: "text" as const, text: collected.source }],
          structuredContent: output,
        };
      } catch (err: unknown) {
        return handleToolError("diagrams_generate_sequence", err);
      }
    },
  );
}
