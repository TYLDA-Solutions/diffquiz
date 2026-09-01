/**
 * Tiny ANSI color helpers. No dependencies, no terminfo — just the handful of
 * SGR codes diffquiz needs. Honors NO_COLOR and non-TTY stdout by default;
 * callers (cli.ts) can force it off via enableColor(false) for --no-color.
 */

let colorEnabled = Boolean(process.stdout.isTTY) && !process.env["NO_COLOR"];

/** Force color on/off, overriding the TTY/NO_COLOR autodetection. */
export function enableColor(on: boolean): void {
  colorEnabled = on;
}

function wrap(code: string): (s: string) => string {
  return (s: string) => (colorEnabled ? `[${code}m${s}[0m` : s);
}

export const bold = wrap("1");
export const dim = wrap("2");
export const green = wrap("32");
export const red = wrap("31");
export const yellow = wrap("33");
export const cyan = wrap("36");

export const color = { bold, dim, green, red, yellow, cyan };
