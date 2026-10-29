import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createNotesServer } from "./notes-server.mjs";

/** Serves the notes MCP server over HTTP on a free local port. Counters show which tools were reached. */
export async function serveNotes(options = {}) {
  const counters = {};
  const headers = [];
  const server = createServer(async (req, res) => {
    headers.push(req.headers);
    const mcp = createNotesServer(counters, options);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    counters,
    headers,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
