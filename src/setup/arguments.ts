export interface SetupOptions {
  client?: string;
  projectRoot: string;
  projectRootExplicit: boolean;
  scope: "global" | "project";
  scopeExplicit: boolean;
  yes: boolean;
  help: boolean;
}

interface FlagSpec {
  names: string[];
  takesValue: boolean;
  apply: (opts: SetupOptions, value: string) => void;
}

// One row per flag; both `--flag value` and `--flag=value` spellings flow
// through the same row. A value-taking flag with no value and nothing
// following falls through to the unknown-flag error, matching history.
const FLAG_SPECS: FlagSpec[] = [
  {
    names: ["--help", "-h"],
    takesValue: false,
    apply: (opts) => {
      opts.help = true;
    },
  },
  {
    names: ["--yes", "-y"],
    takesValue: false,
    apply: (opts) => {
      opts.yes = true;
    },
  },
  {
    names: ["--client"],
    takesValue: true,
    apply: (opts, value) => {
      opts.client = value;
    },
  },
  {
    names: ["--project-root"],
    takesValue: true,
    apply: (opts, value) => {
      opts.projectRoot = value;
      opts.projectRootExplicit = true;
    },
  },
  {
    names: ["--scope"],
    takesValue: true,
    apply: (opts, value) => {
      opts.scope = parseScope(value);
      opts.scopeExplicit = true;
    },
  },
];

export function parseSetupArgs(args: string[]): SetupOptions {
  const opts: SetupOptions = {
    projectRoot: process.cwd(),
    projectRootExplicit: false,
    scope: "global",
    scopeExplicit: false,
    yes: false,
    help: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const eq = arg.indexOf("=");
    const name = eq < 0 ? arg : arg.slice(0, eq);
    const inline = eq < 0 ? undefined : arg.slice(eq + 1);
    const spec = FLAG_SPECS.find((entry) => entry.names.includes(name));
    if (spec === undefined) {
      throw new Error(`Unknown setup flag '${arg}'. Run with --help.`);
    }
    if (!spec.takesValue) {
      if (inline !== undefined) {
        throw new Error(`Unknown setup flag '${arg}'. Run with --help.`);
      }
      spec.apply(opts, "");
      continue;
    }
    if (inline !== undefined) {
      spec.apply(opts, inline);
      continue;
    }
    if (i + 1 >= args.length) {
      throw new Error(`Unknown setup flag '${arg}'. Run with --help.`);
    }
    i += 1;
    spec.apply(opts, args[i]);
  }
  return opts;
}

function parseScope(value: string): "global" | "project" {
  if (value === "global" || value === "project") return value;
  throw new Error(`Invalid --scope '${value}': expected global or project.`);
}
