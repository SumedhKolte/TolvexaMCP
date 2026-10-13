/** One JSON line per event, like the other services. Never pass secrets in here. */
export function log(fields: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...fields })}\n`);
}
