// Terminal rendering toolkit for the guided setup CLI: ANSI styling, box
// drawing, prompt frame rendering, and pure prompt state machines. No I/O:
// every function here is pure and directly unit-testable.

// Wrap text in an ANSI style in capable terminals only: piped output and
// NO_COLOR stay plain so logs and scripts never see escape codes.
export function paint(code: string, text: string): string {
  if (process.env.NO_COLOR !== undefined) return text;
  if (process.stdout.isTTY !== true) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

// Visible cell width: strip ANSI escapes, count pictographs as double.
export function visibleWidth(text: string): number {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  let width = 0;
  for (const ch of plain) {
    width += /\p{Extended_Pictographic}/u.test(ch) ? 2 : 1;
  }
  return width;
}

function padCenter(text: string, width: number): string {
  const pad = Math.max(0, width - visibleWidth(text));
  const left = Math.floor(pad / 2);
  return `${" ".repeat(left)}${text}${" ".repeat(pad - left)}`;
}

// Double-lined terminal card. Width fits the widest line plus padding.
export function box(lines: string[], title?: string): string {
  const inner = Math.max(
    0,
    ...lines.map(visibleWidth),
    title === undefined ? 0 : visibleWidth(title) + 4,
  );
  const width = inner + 4;
  const top =
    title === undefined
      ? `╔${"═".repeat(width)}╗`
      : `╔═ ${title} ${"═".repeat(Math.max(0, width - visibleWidth(title) - 3))}╗`;
  const body = lines.map(
    (line) => `║  ${line}${" ".repeat(Math.max(0, width - visibleWidth(line) - 2))}║`,
  );
  return [top, ...body, `╚${"═".repeat(width)}╝`].join("\n");
}

export function renderBanner(title: string, version: string): string {
  return box([padCenter(`${title}  v${version}`, 40)]);
}

export interface SelectOption {
  label: string;
  hint?: string;
}

export function renderSelect(message: string, options: SelectOption[], active: number): string {
  const lines = [paint("36", `◇ ${message}`)];
  options.forEach((option, index) => {
    const hint = option.hint === undefined ? "" : paint("2", `  ${option.hint}`);
    if (index === active) {
      lines.push(`❯ ${paint("1;36", option.label)}${hint}`);
    } else {
      lines.push(`  ${paint("2", option.label)}${hint}`);
    }
  });
  lines.push(paint("2", "↑↓ to move · Enter to confirm · 1-9 jumps · Esc cancels"));
  return lines.join("\n");
}

export function renderConfirm(message: string, yesActive: boolean): string {
  const yes = yesActive ? `❯ ${paint("1;36", "[ Yes ]")}` : `  ${paint("2", "[ Yes ]")}`;
  const no = yesActive ? `  ${paint("2", "[ No ]")}` : `❯ ${paint("1;36", "[ No ]")}`;
  return [
    `${paint("36", "◇")} ${message}`,
    `${yes}   ${no}`,
    paint("2", "←/→ to toggle · y/n · Enter to confirm"),
  ].join("\n");
}

export type PromptKey =
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "left" }
  | { kind: "right" }
  | { kind: "submit" }
  | { kind: "cancel" }
  | { kind: "digit"; value: number }
  | { kind: "yes" }
  | { kind: "no" }
  | { kind: "other" };

export interface Keypress {
  name?: string;
  ctrl?: boolean;
}

export function normalizeKey(key: Keypress): PromptKey {
  if (key.ctrl === true && key.name === "c") return { kind: "cancel" };
  switch (key.name) {
    case "up":
      return { kind: "up" };
    case "down":
      return { kind: "down" };
    case "left":
      return { kind: "left" };
    case "right":
      return { kind: "right" };
    case "return":
    case "enter":
      return { kind: "submit" };
    case "escape":
      return { kind: "cancel" };
    case "y":
      return { kind: "yes" };
    case "n":
      return { kind: "no" };
    default:
      break;
  }
  if (key.name !== undefined && /^[1-9]$/.test(key.name)) {
    return { kind: "digit", value: Number(key.name) };
  }
  return { kind: "other" };
}

// Frozen confirmation line after a prompt resolves. Messages already
// ending in : or ? keep their punctuation instead of gaining another.
export function frozenLine(message: string, value: string): string {
  const head = paint("36", "◇");
  if (/[?:]$/.test(message)) return `${head} ${message} ${value}`;
  return `${head} ${message}: ${value}`;
}

export interface SelectResult {
  active: number;
  done: boolean;
  cancelled: boolean;
}

export function selectNext(count: number, active: number, key: PromptKey): SelectResult {
  switch (key.kind) {
    case "up":
      return { active: (active - 1 + count) % count, done: false, cancelled: false };
    case "down":
      return { active: (active + 1) % count, done: false, cancelled: false };
    case "submit":
      return { active, done: true, cancelled: false };
    case "cancel":
      return { active, done: false, cancelled: true };
    case "digit":
      if (key.value >= 1 && key.value <= count) {
        return { active: key.value - 1, done: true, cancelled: false };
      }
      return { active, done: false, cancelled: false };
    default:
      return { active, done: false, cancelled: false };
  }
}

export interface ConfirmResult {
  yes: boolean;
  done: boolean;
  cancelled: boolean;
}

export function confirmNext(yes: boolean, key: PromptKey): ConfirmResult {
  switch (key.kind) {
    case "left":
    case "right":
      return { yes: !yes, done: false, cancelled: false };
    case "yes":
      return { yes: true, done: true, cancelled: false };
    case "no":
      return { yes: false, done: true, cancelled: false };
    case "submit":
      return { yes, done: true, cancelled: false };
    case "cancel":
      return { yes, done: false, cancelled: true };
    default:
      return { yes, done: false, cancelled: false };
  }
}

// Byte stream for a frame transition: move up over every owned line and
// explicitly clear each one before writing. Padding short replacements
// with blank clears is what prevents ghost text: finalizing a selection
// redraws one frozen line over an N-line frame, and without the padding
// the other N-1 stale lines would survive underneath the next output.
export function frameTransition(lineCount: number, lines: string[]): string {
  let out = `\x1b[${lineCount}A`;
  for (let index = 0; index < lineCount; index += 1) {
    const line = index < lines.length ? lines[index] : "";
    out += `\r\x1b[2K${line}\n`;
  }
  return out;
}
