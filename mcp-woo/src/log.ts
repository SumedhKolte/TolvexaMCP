/**
 * One JSON object per line on stdout. Callers pass only safe fields: never tool
 * arguments, headers, or anything that could contain a credential.
 */
export function log(fields: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...fields })}\n`);
}
