import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { WooError, type WooClient } from "./woo-client.js";

/** Filled in by the tool wrapper so the request log line can say what happened. */
export interface CallContext {
  tool?: string;
  outcome?: "ok" | "error";
}

// ---------- WooCommerce response shapes (only the fields we read) ----------

interface WcProduct {
  id: number;
  name: string;
  price: string;
  regular_price: string;
  stock_status: string;
  status: string;
  permalink: string;
}

interface WcLineItem {
  name: string;
  quantity: number;
  subtotal: string;
  total: string;
}

interface WcAddress {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  address_1?: string;
  address_2?: string;
  city?: string;
  state?: string;
  postcode?: string;
  country?: string;
}

interface WcOrder {
  id: number;
  number: string;
  status: string;
  currency: string;
  date_created: string;
  date_created_gmt: string;
  date_paid: string | null;
  date_completed: string | null;
  total: string;
  total_tax: string;
  shipping_total: string;
  discount_total: string;
  payment_method_title: string;
  customer_note: string;
  billing: WcAddress;
  line_items: WcLineItem[];
}

// ---------- Output mapping: small, stable shapes for clients and LLMs ----------

const productSummary = (p: WcProduct) => ({
  id: p.id,
  name: p.name,
  price: p.price,
  stock_status: p.stock_status,
  status: p.status,
  permalink: p.permalink,
});

const fullName = (a: WcAddress) => [a.first_name, a.last_name].filter(Boolean).join(" ");

const orderSummary = (o: WcOrder) => ({
  id: o.id,
  number: o.number,
  status: o.status,
  date_created: o.date_created, // store-local time
  date_created_gmt: o.date_created_gmt,
  total: o.total,
  currency: o.currency,
  billing: { name: fullName(o.billing), email: o.billing.email ?? "" },
  line_items: o.line_items.map((li) => ({ name: li.name, quantity: li.quantity })),
});

const orderDetail = (o: WcOrder) => ({
  ...orderSummary(o),
  payment_method: o.payment_method_title,
  date_paid: o.date_paid,
  date_completed: o.date_completed,
  totals: {
    total: o.total,
    tax: o.total_tax,
    shipping: o.shipping_total,
    discount: o.discount_total,
  },
  billing: {
    name: fullName(o.billing),
    email: o.billing.email ?? "",
    phone: o.billing.phone ?? "",
    // Structured, so a consumer can keep city/postcode while dropping the street line.
    address: {
      street: [o.billing.address_1, o.billing.address_2].filter(Boolean).join(", "),
      city: o.billing.city ?? "",
      state: o.billing.state ?? "",
      postcode: o.billing.postcode ?? "",
      country: o.billing.country ?? "",
    },
  },
  customer_note: o.customer_note,
  line_items: o.line_items.map((li) => ({
    name: li.name,
    quantity: li.quantity,
    subtotal: li.subtotal,
    total: li.total,
  })),
});

// ---------- Input schemas ----------

export const ORDER_STATUSES = ["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"] as const;

const perPage = z.number().int().min(1).max(100).default(20).describe("Results per page, 1-100 (default 20).");
const page = z.number().int().min(1).default(1).describe("Page number, starting at 1 (default 1).");
const orderId = z.number().int().positive().describe("WooCommerce order ID.");

/**
 * Accepts an ISO 8601 datetime (with or without offset) or a plain date, and normalizes
 * it to UTC ("...Z"). Values without an offset are read as UTC. LLMs often send plain
 * dates, so being lenient here avoids pointless validation round-trips.
 */
const isoDate = z
  .string()
  .refine((v) => /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v)), {
    message: "must be an ISO 8601 date or datetime, e.g. 2026-10-11 or 2026-10-11T00:00:00Z",
  })
  .transform((v) => new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(v) || v.length === 10 ? v : `${v}Z`).toISOString());

// ---------- Registration ----------

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/**
 * Wraps a tool body: records the outcome for logging and converts failures into MCP
 * tool errors (isError: true) with short messages. Unknown errors become a generic
 * message; their details are never sent to the client.
 */
function handler<A>(
  ctx: CallContext,
  name: string,
  notFound: (args: A) => string,
  body: (args: A) => Promise<CallToolResult>,
) {
  return async (args: A): Promise<CallToolResult> => {
    ctx.tool = name;
    try {
      const result = await body(args);
      ctx.outcome = "ok";
      return result;
    } catch (err) {
      ctx.outcome = "error";
      if (err instanceof WooError) {
        return toolError(err.kind === "not_found" ? notFound(args) : err.message);
      }
      return toolError("Internal error in the WooCommerce MCP server");
    }
  };
}

export function registerWooTools(server: McpServer, woo: WooClient, ctx: CallContext): void {
  server.registerTool(
    "list_products",
    {
      title: "List products",
      description:
        "List products in the WooCommerce store. Optionally filter by a search term or status. " +
        "Returns id, name, price, stock_status, status and permalink, plus pagination totals.",
      inputSchema: {
        search: z.string().min(1).max(200).optional().describe("Text to search for in product names/descriptions."),
        status: z.enum(["publish", "draft", "any"]).optional().describe("Product status filter (default: any)."),
        per_page: perPage,
        page,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(ctx, "list_products", () => "Products not found", async (a) => {
      const r = await woo.get<WcProduct[]>("/products", {
        search: a.search,
        status: a.status ?? "any",
        per_page: a.per_page,
        page: a.page,
      });
      return json({ page: a.page, per_page: a.per_page, total: r.total, total_pages: r.totalPages, products: r.data.map(productSummary) });
    }),
  );

  server.registerTool(
    "create_product",
    {
      title: "Create product",
      description:
        "Create a simple product in the WooCommerce store. It is published (visible on the storefront) " +
        "unless another status is given. Returns the new product's id and permalink.",
      inputSchema: {
        name: z.string().min(1).max(200).describe("Product name."),
        regular_price: z
          .string()
          .regex(/^\d+(\.\d{1,2})?$/, 'must be a decimal string such as "19.99"')
          .describe('Price as a decimal string, e.g. "19.99".'),
        description: z.string().max(5000).optional().describe("Product description (plain text or simple HTML)."),
        status: z.enum(["publish", "draft", "pending", "private"]).default("publish").describe("Default: publish."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handler(ctx, "create_product", () => "Product not found", async (a) => {
      const r = await woo.post<WcProduct>("/products", {
        name: a.name,
        type: "simple",
        regular_price: a.regular_price,
        description: a.description,
        status: a.status,
      });
      const p = r.data;
      return json({ id: p.id, name: p.name, status: p.status, regular_price: p.regular_price, permalink: p.permalink });
    }),
  );

  server.registerTool(
    "list_orders",
    {
      title: "List orders",
      description:
        "List orders, newest first. Filter by status and by creation time: `after`/`before` take ISO 8601 " +
        "dates or datetimes (UTC unless an offset is given). For today's orders pass after=<today>T00:00:00Z. " +
        "Returns id, number, status, date_created, total, currency, billing name and email, and line items.",
      inputSchema: {
        status: z.enum([...ORDER_STATUSES, "any"]).optional().describe("Order status filter (default: any)."),
        after: isoDate.optional().describe("Only orders created after this time (ISO 8601)."),
        before: isoDate.optional().describe("Only orders created before this time (ISO 8601)."),
        per_page: perPage,
        page,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(ctx, "list_orders", () => "Orders not found", async (a) => {
      const r = await woo.get<WcOrder[]>("/orders", {
        status: a.status ?? "any",
        after: a.after,
        before: a.before,
        // after/before are UTC (normalized above), so compare against date_created_gmt.
        dates_are_gmt: a.after || a.before ? true : undefined,
        orderby: "date",
        order: "desc",
        per_page: a.per_page,
        page: a.page,
      });
      return json({ page: a.page, per_page: a.per_page, total: r.total, total_pages: r.totalPages, orders: r.data.map(orderSummary) });
    }),
  );

  server.registerTool(
    "get_order",
    {
      title: "Get order",
      description: "Get the full summary of one order by its ID: status, dates, totals, payment method, billing details, and line items.",
      inputSchema: { id: orderId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(ctx, "get_order", (a) => `Order ${a.id} not found`, async (a) => {
      const r = await woo.get<WcOrder>(`/orders/${a.id}`);
      return json(orderDetail(r.data));
    }),
  );

  server.registerTool(
    "update_order_status",
    {
      title: "Update order status",
      description:
        "Change an order's status (e.g. processing -> completed). This changes store data and can trigger " +
        "customer-facing effects such as emails or stock changes. Returns the updated order.",
      inputSchema: {
        id: orderId,
        status: z.enum(ORDER_STATUSES).describe("New status."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handler(ctx, "update_order_status", (a) => `Order ${a.id} not found`, async (a) => {
      const r = await woo.put<WcOrder>(`/orders/${a.id}`, { status: a.status });
      return json(orderDetail(r.data));
    }),
  );
}
