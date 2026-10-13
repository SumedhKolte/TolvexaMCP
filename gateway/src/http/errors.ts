import type { z } from "zod";

/** An error with an HTTP status and a stable code, rendered as {"error":{"code","message"}}. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (message: string) => new HttpError(400, "VALIDATION_ERROR", message);
export const unauthorized = (message = "Authentication required") => new HttpError(401, "UNAUTHORIZED", message);
export const forbidden = (message = "Not allowed") => new HttpError(403, "FORBIDDEN", message);
export const notFound = (message = "Not found") => new HttpError(404, "NOT_FOUND", message);
export const conflict = (message: string) => new HttpError(409, "CONFLICT", message);

/** Validates with zod; on failure throws a 400 naming the first bad field. */
export function parseBody<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const issue = r.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw badRequest(`${where}${issue?.message ?? "invalid request"}`);
  }
  return r.data;
}

/** Postgres unique-violation detection, through drizzle's error wrapping. */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}
