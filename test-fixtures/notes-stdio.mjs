import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createNotesServer } from "./notes-server.mjs";

await createNotesServer().connect(new StdioServerTransport());
