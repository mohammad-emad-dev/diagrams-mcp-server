// Interactive prompt drivers for the guided setup CLI: raw-mode TTY
// select/confirm prompts with a numbered legacy fallback. Rendering comes
// from ./terminal.js; client labels live in ./clients.js.
import readline from "node:readline";
import { CLIENT_LABELS, SETUP_CLIENTS } from "./clients.js";
import type { SetupClient } from "./clients.js";
import {
  confirmNext,
  frameTransition,
  frozenLine,
  normalizeKey,
  paint,
  renderConfirm,
  renderSelect,
  selectNext,
} from "./terminal.js";
import type { Keypress, SelectOption } from "./terminal.js";

function setRawModeSafe(mode: boolean): boolean {
  const stdin = process.stdin as unknown as { setRawMode?: (mode: boolean) => void };
  if (typeof stdin.setRawMode !== "function") return false;
  try {
    stdin.setRawMode(mode);
    return true;
  } catch {
    return false;
  }
}

let keypressEventsEnabled = false;

function rewriteFrame(lineCount: number, lines: string[]): void {
  process.stdout.write(frameTransition(lineCount, lines));
}

async function selectPromptLegacy(
  message: string,
  options: SelectOption[],
  initial: number,
): Promise<number> {
  console.log(message);
  options.forEach((option, index) => {
    console.log(`  ${index + 1}. ${option.label}`);
  });
  for (;;) {
    const answer = await ask(`Choose 1-${options.length} [${initial + 1}]: `, String(initial + 1));
    const choice = Number(answer);
    if (Number.isInteger(choice) && choice >= 1 && choice <= options.length) {
      return choice - 1;
    }
    console.log(`Enter a number between 1 and ${options.length}.`);
  }
}

async function selectPrompt(
  message: string,
  options: SelectOption[],
  initial = 0,
): Promise<number | undefined> {
  if (process.stdin.isTTY !== true || !setRawModeSafe(true)) {
    return selectPromptLegacy(message, options, initial);
  }
  if (!keypressEventsEnabled) {
    readline.emitKeypressEvents(process.stdin);
    keypressEventsEnabled = true;
  }
  process.stdin.resume();
  process.stdout.write("\x1b[?25l");
  let active = initial;
  const lineCount = renderSelect(message, options, active).split("\n").length;
  process.stdout.write(`${renderSelect(message, options, active)}\n`);
  try {
    return await new Promise<number | undefined>((resolve) => {
      const onKey = (_chunk: unknown, key: Keypress): void => {
        const next = selectNext(options.length, active, normalizeKey(key));
        active = next.active;
        if (next.cancelled || next.done) {
          process.stdin.removeListener("keypress", onKey);
          if (next.done) {
            rewriteFrame(lineCount, [frozenLine(message, options[active].label)]);
          }
          resolve(next.done ? active : undefined);
          return;
        }
        rewriteFrame(lineCount, renderSelect(message, options, active).split("\n"));
      };
      process.stdin.on("keypress", onKey);
    });
  } finally {
    setRawModeSafe(false);
    process.stdin.pause();
    process.stdout.write("\x1b[?25h");
  }
}

async function askConfirmLegacy(question: string, initialYes: boolean): Promise<boolean> {
  const fallback = initialYes ? "y" : "n";
  for (;;) {
    const answer = (await ask(`${question} [${initialYes ? "Y/n" : "y/N"}]: `, fallback))
      .trim()
      .toLowerCase();
    if (answer === "" || answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    console.log("Enter y or n.");
  }
}

export async function confirmPrompt(question: string, initialYes = true): Promise<boolean> {
  if (process.stdin.isTTY !== true || !setRawModeSafe(true)) {
    return askConfirmLegacy(question, initialYes);
  }
  if (!keypressEventsEnabled) {
    readline.emitKeypressEvents(process.stdin);
    keypressEventsEnabled = true;
  }
  process.stdin.resume();
  process.stdout.write("\x1b[?25l");
  let yes = initialYes;
  const lineCount = renderConfirm(question, yes).split("\n").length;
  process.stdout.write(`${renderConfirm(question, yes)}\n`);
  try {
    return await new Promise<boolean>((resolve) => {
      const onKey = (_chunk: unknown, key: Keypress): void => {
        const next = confirmNext(yes, normalizeKey(key));
        yes = next.yes;
        if (next.cancelled) {
          process.stdin.removeListener("keypress", onKey);
          resolve(false);
          return;
        }
        if (next.done) {
          process.stdin.removeListener("keypress", onKey);
          rewriteFrame(lineCount, [frozenLine(question, yes ? "Yes" : "No")]);
          resolve(yes);
          return;
        }
        rewriteFrame(lineCount, renderConfirm(question, yes).split("\n"));
      };
      process.stdin.on("keypress", onKey);
    });
  } finally {
    setRawModeSafe(false);
    process.stdin.pause();
    process.stdout.write("\x1b[?25h");
  }
}

export function abortSetup(): never {
  console.log(paint("31", "✖ Setup cancelled."));
  process.exit(1);
}

export async function ask(question: string, fallback: string): Promise<string> {
  if (!process.stdin.isTTY) return fallback;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
    const trimmed = answer.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  } finally {
    rl.close();
  }
}

export async function pickClient(): Promise<SetupClient> {
  const index =
    (await selectPrompt(
      "Which client should use diagrams-mcp-server?",
      SETUP_CLIENTS.map((client) => ({ label: CLIENT_LABELS[client] })),
    )) ?? abortSetup();
  return SETUP_CLIENTS[index];
}

export async function pickScope(): Promise<"global" | "project"> {
  const index =
    (await selectPrompt("Setup scope:", [
      { label: "Global (Recommended)", hint: "clean config, follows the working directory" },
      { label: "Project-specific", hint: "pins PROJECT_ROOT for this project" },
    ])) ?? abortSetup();
  return index === 0 ? "global" : "project";
}
