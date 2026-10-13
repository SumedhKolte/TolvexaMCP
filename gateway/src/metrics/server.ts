import { createServer, type Server } from "node:http";
import type { GatewayMetrics } from "./index.js";

/**
 * A separate listener for GET /metrics. It is not the API port, so the Ingress (which
 * only routes to the API port) can never expose it; the NetworkPolicy decides who in the
 * cluster may scrape it. Everything else gets 404.
 */
export function startMetricsServer(metrics: GatewayMetrics, port: number, host = "0.0.0.0", onError?: (err: unknown) => void): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== "GET" || (req.url ?? "").split("?")[0] !== "/metrics") {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
      return;
    }
    metrics.render().then(
      ({ contentType, body }) => res.writeHead(200, { "content-type": contentType, "cache-control": "no-store" }).end(body),
      (err: unknown) => {
        onError?.(err);
        res.writeHead(500, { "content-type": "text/plain" }).end("metrics unavailable\n");
      },
    );
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
