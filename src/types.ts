/** A JSON Schema object that describes one tool's input. */
export type JsonSchema = Record<string, unknown>;

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean }
  /** A block only the named provider reads (for example reasoning). Adapters send it back unchanged. */
  | { type: "provider_block"; provider: string; raw: unknown };

export interface Message {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface ModelRequest {
  system?: string;
  messages: Message[];
  tools: ToolSpec[];
  maxOutputTokens: number;
  signal?: AbortSignal;
}

export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "message"; content: ContentBlock[]; stopReason: StopReason; usage: Usage };

/** Prices in US dollars per million tokens. */
export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

/**
 * The model port. An adapter streams text deltas, then yields one final
 * `message` event with the whole assistant turn, the stop reason, and usage.
 */
export interface ModelProvider {
  readonly name: string;
  readonly model: string;
  readonly pricing?: Pricing;
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}
