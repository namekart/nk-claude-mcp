/**
 * Stateful Streamable HTTP MCP — Coolify / remote Claude Desktop.
 * Protect with MCP_AUTH_TOKEN Bearer when set (required in production).
 */
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createNkClaudeServer, TOOL_NAMES } from "./createServer.js";

const sessions = new Map();

function unauthorized(res) {
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Unauthorized" },
    id: null,
  });
}

function checkAuth(req, res) {
  const expected = (process.env.MCP_AUTH_TOKEN || "").trim();
  if (!expected) {
    // Fail closed on HTTP: public MCP without a secret is unsafe.
    process.stderr.write(
      "[nk-claude-mcp] MCP_AUTH_TOKEN is not set — refusing HTTP requests\n"
    );
    unauthorized(res);
    return false;
  }
  const header = req.headers.authorization || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (token !== expected) {
    unauthorized(res);
    return false;
  }
  return true;
}

async function handleMcpPost(req, res) {
  if (!checkAuth(req, res)) return;

  try {
    const sessionId = req.headers["mcp-session-id"];
    let session = sessionId ? sessions.get(sessionId) : undefined;

    if (!session && !sessionId && isInitializeRequest(req.body)) {
      const server = createNkClaudeServer();
      let transport;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server });
        },
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) sessions.delete(id);
        server.close().catch(() => {});
      };
      await server.connect(transport);
      session = { transport, server };
    }

    if (!session) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid or missing MCP session" },
        id: null,
      });
      return;
    }

    await session.transport.handleRequest(req, res, req.body);
  } catch (error) {
    process.stderr.write(
      `[nk-claude-mcp] HTTP MCP error: ${error instanceof Error ? error.message : String(error)}\n`
    );
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}

async function handleSessionRequest(req, res) {
  if (!checkAuth(req, res)) return;

  const sessionId = req.headers["mcp-session-id"];
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Invalid or missing MCP session" },
      id: null,
    });
    return;
  }

  try {
    await session.transport.handleRequest(req, res);
  } catch (error) {
    process.stderr.write(
      `[nk-claude-mcp] HTTP MCP session error: ${error instanceof Error ? error.message : String(error)}\n`
    );
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}

export async function startHttpServer() {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "0.0.0.0";
  const app = createMcpExpressApp({ host });

  app.get("/health", (_req, res) => {
    res.status(200).json({
      ok: true,
      name: "nk-claude-mcp",
      transport: "streamable-http",
      tools: TOOL_NAMES.split(","),
    });
  });

  app.post("/mcp", handleMcpPost);
  app.get("/mcp", handleSessionRequest);
  app.delete("/mcp", handleSessionRequest);

  await new Promise((resolve, reject) => {
    const server = app.listen(port, host, (err) => {
      if (err) reject(err);
      else resolve(server);
    });
  });

  process.stderr.write(
    `[nk-claude-mcp] streamable-http listening on http://${host}:${port}/mcp tools=${TOOL_NAMES}\n`
  );
}
