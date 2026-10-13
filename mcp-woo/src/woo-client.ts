import { oauthAuthorizationHeader } from "./oauth1.js";

/** Failure categories; tools.ts turns these into short MCP tool errors. */
export type WooErrorKind = "not_found" | "auth" | "bad_request" | "upstream" | "timeout" | "unreachable";

/**
 * An error safe to show to an MCP client: the message is short, never contains
 * credentials, URLs with signatures, HTML, or stack traces.
 */
export class WooError extends Error {
  constructor(
    readonly kind: WooErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "WooError";
  }
}

export interface Credentials {
  consumerKey: string;
  consumerSecret: string;
}

export interface WooClientOptions {
  baseUrl: string;
  signatureBaseUrl: string;
  timeoutMs: number;
  credentials: () => Promise<Credentials | undefined>;
  fetchImpl?: typeof fetch;
}

export interface WooResponse<T> {
  data: T;
  /** X-WP-Total / X-WP-TotalPages for list endpoints. */
  total?: number;
  totalPages?: number;
}

type Query = Record<string, string | number | boolean | undefined>;

const API_PREFIX = "/wp-json/wc/v3";

/**
 * Removes anything that must not reach a client: HTML tags, WooCommerce key material
 * (defense in depth: WooCommerce doesn't echo keys, but we never rely on that), and
 * excess length.
 */
export function sanitizeMessage(raw: unknown, max = 200): string {
  const text = String(raw ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\b(ck|cs)_[A-Za-z0-9]{16,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export class WooClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: WooClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get<T>(path: string, query: Query = {}) {
    return this.request<T>("GET", path, query);
  }
  post<T>(path: string, body: unknown) {
    return this.request<T>("POST", path, {}, body);
  }
  put<T>(path: string, body: unknown) {
    return this.request<T>("PUT", path, {}, body);
  }

  private async request<T>(method: string, path: string, query: Query, body?: unknown): Promise<WooResponse<T>> {
    const creds = await this.opts.credentials();
    if (!creds) {
      throw new WooError("auth", "WooCommerce credentials are not configured on the server");
    }

    // Drop undefined params; everything else becomes a string (and is signed as such).
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) params[k] = String(v);
    }
    const qs = new URLSearchParams(params).toString();
    const apiPath = `${API_PREFIX}${path}`;

    const authorization = oauthAuthorizationHeader({
      method,
      signatureUrl: `${this.opts.signatureBaseUrl}${apiPath}`,
      query: params,
      consumerKey: creds.consumerKey,
      consumerSecret: creds.consumerSecret,
    });

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl}${apiPath}${qs ? `?${qs}` : ""}`, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: authorization,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        // A redirect would mean WordPress is sending us to its public URL (outside the
        // cluster); treat it as an error instead of following it.
        redirect: "manual",
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new WooError("timeout", `WooCommerce did not respond within ${Math.round(this.opts.timeoutMs / 1000)}s`);
      }
      // Network errors carry socket details, not secrets, but there's no reason to expose them.
      throw new WooError("unreachable", "WooCommerce is unreachable");
    }

    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined; // HTML error page etc.: never forwarded
    }

    if (res.status >= 300 && res.status < 400) {
      throw new WooError("upstream", `WooCommerce answered with an unexpected redirect (HTTP ${res.status})`, res.status);
    }
    if (!res.ok) {
      throw toWooError(res.status, json);
    }
    if (json === undefined) {
      throw new WooError("upstream", "WooCommerce returned a response that is not JSON", res.status);
    }

    const num = (h: string) => {
      const v = res.headers.get(h);
      return v === null ? undefined : Number(v);
    };
    return { data: json as T, total: num("x-wp-total"), totalPages: num("x-wp-totalpages") };
  }
}

function toWooError(status: number, json: unknown): WooError {
  const wc = (json ?? {}) as { code?: unknown; message?: unknown };
  const detail = sanitizeMessage(wc.message);
  // WooCommerce answers a missing ID with 404 on reads but 400 + "<type>_invalid_id" on
  // updates (e.g. woocommerce_rest_shop_order_invalid_id); both mean "not found".
  if (status === 404 || (typeof wc.code === "string" && wc.code.endsWith("_invalid_id"))) {
    return new WooError("not_found", "Not found", status);
  }
  if (status === 401 || status === 403) {
    return new WooError("auth", `WooCommerce rejected the request (HTTP ${status})${detail ? `: ${detail}` : ""}`, status);
  }
  if (status >= 400 && status < 500) {
    return new WooError("bad_request", detail || `WooCommerce rejected the request (HTTP ${status})`, status);
  }
  return new WooError("upstream", `WooCommerce returned HTTP ${status}`, status);
}
