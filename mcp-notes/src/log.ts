/** One JSON object per line on stdout. Never pass tool arguments or headers here. */
export function log(fields: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...fields })}\n`);
}
