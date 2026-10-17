/** stdout carries results (JSON with `--json`); stderr carries progress and notes for people. */
export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printLine(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

export function note(text: string): void {
  process.stderr.write(`${text}\n`);
}
