// Setup project-root prompt/policy: confirm-or-create loop plus the
// scope rule that decides whether PROJECT_ROOT is baked into a config.
import type { SetupOptions } from "./arguments.js";
import { paint } from "./terminal.js";

export interface PathPromptDeps {
  exists: (path: string) => boolean;
  mkdir: (path: string) => Promise<void>;
  confirm: (question: string) => Promise<boolean>;
  reprompt: (question: string, fallback: string) => Promise<string>;
}

// Loop until root passes the provided exists check: offer to create a
// missing entry, otherwise re-ask. A failed mkdir falls back to
// re-prompting so a permission error never strands the user.
export async function ensureProjectRoot(root: string, deps: PathPromptDeps): Promise<string> {
  let current = root;
  for (;;) {
    if (deps.exists(current)) return current;
    console.log(paint("33", `⚠ Directory does not exist: ${current}`));
    if (await deps.confirm("Create this directory?")) {
      try {
        await deps.mkdir(current);
        console.log(paint("32", `✔ Created ${current}`));
        return current;
      } catch (err: unknown) {
        console.log(
          paint("31", `✖ Could not create directory: ${err instanceof Error ? err.message : err}`),
        );
      }
    }
    const next = (await deps.reprompt(`Project root [${current}]: `, current)).trim();
    current = next.length > 0 ? next : current;
  }
}

// Global scope writes a clean config and follows the working directory;
// project scope pins one PROJECT_ROOT. An explicit --project-root always
// wins over the global default.
export function shouldBakeProjectRoot(opts: SetupOptions): boolean {
  return opts.scope === "project" || opts.projectRootExplicit;
}
