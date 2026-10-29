import { AssistantApiError, createClient, type AssistantClient } from "./client.js";
import { ConfigError } from "./chat.js";
import { printable } from "./text.js";

export interface RemoteConfig {
  api: string;
  apiTokenEnv: string;
}

/** Builds the typed client. The token comes from an environment variable. */
export function clientFor(config: RemoteConfig, env: Record<string, string | undefined>): AssistantClient {
  const token = env[config.apiTokenEnv];
  if (!token) throw new ConfigError(`environment variable ${config.apiTokenEnv} is not set`);
  try {
    return createClient({ baseUrl: config.api, token });
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : String(error));
  }
}

export type RemoteCommand =
  | { name: "tools" }
  | { name: "approvals" }
  | { name: "approve"; id: string; digest: string }
  | { name: "deny"; id: string; reason?: string };

const line = (value: string) => printable(value).replace(/\s+/g, " ");

/** Runs one remote command. Returns JSON-able data and text for a person. */
export async function runRemote(client: AssistantClient, command: RemoteCommand): Promise<{ data: unknown; text: string }> {
  switch (command.name) {
    case "tools": {
      const tools = await client.tools();
      const rows = tools.map((tool) => `${line(tool.name)}  ${tool.risk}  ${line(tool.scope)}  ${line(tool.description)}`);
      return { data: { tools }, text: rows.length > 0 ? rows.join("\n") : "no tools" };
    }
    case "approvals": {
      const approvals = await client.approvals();
      const rows = approvals.map((a) => `${line(a.id)}  ${line(a.tool)} (${a.risk})  digest ${line(a.digest)}  ${a.canDecide ? "you may decide" : "you may not decide"}  ${line(JSON.stringify(a.input))}`);
      return { data: { approvals }, text: rows.length > 0 ? rows.join("\n") : "no pending approvals" };
    }
    case "approve":
    case "deny": {
      const decision = command.name === "approve" ? await client.approve(command.id, command.digest) : await client.deny(command.id, command.reason);
      return { data: decision, text: `${decision.approved ? "approved" : "denied"} ${line(decision.requestId)} by ${line(decision.decidedBy)}${decision.machineMade ? " (machine-made)" : ""}` };
    }
  }
}

export function describeFailure(error: unknown): string {
  if (error instanceof AssistantApiError) return `${error.code}: ${line(error.message)}`;
  return error instanceof Error ? `${error.name}: ${line(error.message)}` : line(String(error));
}
