/**
 * Cloudflare Worker for Quotation Web App
 * Uses Cloudflare KV namespace 'work' (supporting env.work or env.weel binding)
 */

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return handleOptions(request);
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    // Helper for CORS response headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    const jsonResponse = (data, status = 200) => {
      return new Response(JSON.stringify(data), {
        status,
        headers: {
          "Content-Type": "application/json;charset=UTF-8",
          ...corsHeaders,
        },
      });
    };

    const errorResponse = (message, status = 400) => {
      return jsonResponse({ success: false, error: message }, status);
    };

    try {
      // Resolve KV namespace safely regardless of whether bound as 'work' or 'weel'
      const kv = env && (env.work || env.weel);

      // Health check or root endpoint
      if (pathname === "/" || pathname === "/api" || pathname === "/api/health") {
        return jsonResponse({
          success: true,
          service: "Quotation API",
          namespace: "work",
          endpoints: [
            { method: "GET", path: "/api/quotes", description: "List all quotations" },
            { method: "GET", path: "/api/quotes/:id", description: "Get quotation by ID" },
            { method: "POST", path: "/api/quotes", description: "Create a quotation" },
            { method: "PUT", path: "/api/quotes/:id", description: "Update a quotation" },
            { method: "DELETE", path: "/api/quotes/:id", description: "Delete a quotation" },
          ],
        });
      }

      // Ensure KV namespace is bound
      if (!kv) {
        return errorResponse("Cloudflare KV namespace 'work' is not bound. Please bind 'work' in wrangler.toml or Worker settings.", 500);
      }

      // Router for /api/quotes
      const quotesMatch = pathname.match(/^\/api\/quotes(?:\/([^\/]+))?\/?$/);
      if (quotesMatch) {
        const id = quotesMatch[1] ? decodeURIComponent(quotesMatch[1]) : null;

        // GET /api/quotes or GET /api/quotes/:id
        if (request.method === "GET") {
          if (id) {
            const rawData = await kv.get(`quote:${id}`);
            if (!rawData) {
              return errorResponse(`Quotation with id '${id}' not found`, 404);
            }
            const quote = JSON.parse(rawData);
            return jsonResponse({ success: true, quotation: quote });
          } else {
            // List all quotations
            // KV list returns keys with prefix 'quote:'
            const listResult = await kv.list({ prefix: "quote:" });
            const quotes = [];
            for (const key of listResult.keys) {
              // Read summary metadata or full data
              const rawData = await kv.get(key.name);
              if (rawData) {
                try {
                  const parsed = JSON.parse(rawData);
                  quotes.push(parsed);
                } catch (e) {
                  // ignore malformed items
                }
              }
            }

            // Sort newest first by createdAt or date
            quotes.sort((a, b) => {
              const timeA = new Date(a.updatedAt || a.createdAt || a.date || 0).getTime();
              const timeB = new Date(b.updatedAt || b.createdAt || b.date || 0).getTime();
              return timeB - timeA;
            });

            return jsonResponse({ success: true, count: quotes.length, quotations: quotes });
          }
        }

        // POST /api/quotes (Create new quotation)
        if (request.method === "POST") {
          let body;
          try {
            body = await request.json();
          } catch (e) {
            return errorResponse("Invalid JSON payload", 400);
          }

          const quoteId = body.id || body.quoteNumber || `Q-${Date.now()}`;
          const now = new Date().toISOString();

          const quoteData = {
            ...body,
            id: quoteId,
            quoteNumber: body.quoteNumber || quoteId,
            createdAt: body.createdAt || now,
            updatedAt: now,
          };

          const keyName = `quote:${quoteId}`;
          await kv.put(keyName, JSON.stringify(quoteData), {
            metadata: {
              id: quoteId,
              clientName: quoteData.clientName || "",
              date: quoteData.date || "",
              total: quoteData.total || 0,
            },
          });

          return jsonResponse({
            success: true,
            message: "Quotation saved successfully to KV namespace 'work'",
            quotation: quoteData,
          }, 201);
        }

        // PUT /api/quotes/:id (Update existing quotation)
        if (request.method === "PUT") {
          if (!id) {
            return errorResponse("Quotation ID is required in URL", 400);
          }

          let body;
          try {
            body = await request.json();
          } catch (e) {
            return errorResponse("Invalid JSON payload", 400);
          }

          const existingRaw = await kv.get(`quote:${id}`);
          let existingData = {};
          if (existingRaw) {
            try {
              existingData = JSON.parse(existingRaw);
            } catch (e) {}
          }

          const now = new Date().toISOString();
          const updatedQuote = {
            ...existingData,
            ...body,
            id: id,
            updatedAt: now,
          };

          const keyName = `quote:${id}`;
          await kv.put(keyName, JSON.stringify(updatedQuote), {
            metadata: {
              id: id,
              clientName: updatedQuote.clientName || "",
              date: updatedQuote.date || "",
              total: updatedQuote.total || 0,
            },
          });

          return jsonResponse({
            success: true,
            message: "Quotation updated successfully in KV namespace 'work'",
            quotation: updatedQuote,
          });
        }

        // DELETE /api/quotes/:id (Delete quotation)
        if (request.method === "DELETE") {
          if (!id) {
            return errorResponse("Quotation ID is required in URL", 400);
          }

          const keyName = `quote:${id}`;
          const existing = await kv.get(keyName);
          if (!existing) {
            return errorResponse(`Quotation with id '${id}' not found`, 404);
          }

          await kv.delete(keyName);

          return jsonResponse({
            success: true,
            message: `Quotation '${id}' deleted successfully from KV namespace 'work'`,
            id: id,
          });
        }

        return errorResponse(`Method ${request.method} not allowed on /api/quotes`, 405);
      }

      return errorResponse("Endpoint not found", 404);
    } catch (err) {
      return jsonResponse({ success: false, error: err.message || "Internal Server Error" }, 500);
    }
  },
};

function handleOptions(request) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
  return new Response(null, { headers, status: 204 });
}
