import type { IncomingHttpHeaders } from "node:http";
export function serveNotes(options?: { badNames?: number }): Promise<{
  url: string;
  counters: Record<string, number>;
  headers: IncomingHttpHeaders[];
  close(): Promise<void>;
}>;
