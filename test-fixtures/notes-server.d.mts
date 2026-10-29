import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
export function createNotesServer(
  counters?: Record<string, number>,
  options?: { pageSize?: number; endless?: boolean; duplicate?: boolean },
): Server;
