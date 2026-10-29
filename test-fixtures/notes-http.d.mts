import type { IncomingHttpHeaders } from "node:http";
export function serveNotes(): Promise<{
  url: string;
  counters: Record<string, number>;
  headers: IncomingHttpHeaders[];
  close(): Promise<void>;
}>;
