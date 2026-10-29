import Anthropic from "@anthropic-ai/sdk";
import {
  ProviderError,
  type ContentBlock,
  type Message,
  type ModelEvent,
  type ModelProvider,
  type ModelRequest,
  type Pricing,
  type StopReason,
} from "../types.js";

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";

// US dollars per million tokens. Override with the `pricing` option.
const KNOWN_PRICING: Record<string, Pricing> = {
  "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20 },
  "claude-haiku-5-5": { inputPerMTok: 0.1, outputPerMTok: 0.5 },
};

export interface AnthropicProviderOptions {
  /** Read from ANTHROPIC_API_KEY when absent. */
  apiKey?: string;
  /** Point at a gateway or an EU-hosted Anthropic endpoint. */
  baseUrl?: string;
  model?: string;
  pricing?: Pricing;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  client?: Anthropic;
}

const STOP_REASONS: Record<string, StopReason> = {
  end_turn: "end_turn",
  stop_sequence: "end_turn",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  refusal: "refusal",
};

function toAnthropicMessages(messages: readonly Message[]): Anthropic.MessageParam[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.flatMap((block): Anthropic.ContentBlockParam[] => {
      switch (block.type) {
        case "text":
          return block.text.length > 0 ? [{ type: "text", text: block.text }] : [];
        case "tool_use":
          return [{ type: "tool_use", id: block.id, name: block.name, input: block.input }];
        case "tool_result":
          return [{ type: "tool_result", tool_use_id: block.toolUseId, content: block.content, is_error: block.isError ?? false }];
        case "provider_block":
          return block.provider === "anthropic" ? [block.raw as Anthropic.ContentBlockParam] : [];
      }
    }),
  }));
}

function fromAnthropicContent(content: Anthropic.ContentBlock[]): ContentBlock[] {
  return content.map((block): ContentBlock => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "tool_use") return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    return { type: "provider_block", provider: "anthropic", raw: block };
  });
}

export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";
  readonly model: string;
  readonly pricing?: Pricing;
  private readonly client: Anthropic;
  private readonly effort?: AnthropicProviderOptions["effort"];

  constructor(options: AnthropicProviderOptions = {}) {
    this.model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.pricing = options.pricing ?? KNOWN_PRICING[this.model];
    this.effort = options.effort;
    this.client =
      options.client ?? new Anthropic({ apiKey: options.apiKey, baseURL: options.baseUrl });
  }

  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: request.maxOutputTokens,
        ...(request.system !== undefined ? { system: request.system } : {}),
        messages: toAnthropicMessages(request.messages),
        ...(request.tools.length > 0
          ? {
              tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
              })),
            }
          : {}),
        ...(this.effort !== undefined ? { output_config: { effort: this.effort } } : {}),
      },
      { signal: request.signal },
    );
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield { type: "text_delta", text: event.delta.text };
      }
    }
    const message = await stream.finalMessage();
    const usage = message.usage;
    if (typeof usage?.input_tokens !== "number" || typeof usage.output_tokens !== "number") {
      throw new ProviderError("anthropic response carried no token usage");
    }
    yield {
      type: "message",
      content: fromAnthropicContent(message.content),
      stopReason: STOP_REASONS[message.stop_reason ?? ""] ?? "other",
      usage: {
        inputTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
        outputTokens: usage.output_tokens,
      },
    };
  }
}
