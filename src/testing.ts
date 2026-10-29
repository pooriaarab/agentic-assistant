import type { ContentBlock, ModelEvent, ModelProvider, ModelRequest, Pricing, StopReason, Usage } from "./types.js";

export interface ScriptedTurn {
  text?: string;
  toolCalls?: { name: string; input: unknown; id?: string }[];
  /** Default: "tool_use" when there are tool calls, else "end_turn". */
  stopReason?: StopReason;
  usage?: Usage;
}

/**
 * A model that replays a fixed script, one turn per request. Use it in E2E
 * tests so runs are deterministic. It records each request it receives.
 */
export class ScriptedProvider implements ModelProvider {
  readonly name = "scripted";
  readonly model = "scripted-1";
  readonly requests: ModelRequest[] = [];
  private next = 0;

  constructor(
    private readonly script: readonly ScriptedTurn[],
    readonly pricing?: Pricing,
  ) {}

  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    this.requests.push({ ...request, messages: structuredClone(request.messages) });
    const turn = this.script[this.next++];
    if (turn === undefined) throw new Error(`scripted provider ran out of turns at request ${this.next}`);
    const content: ContentBlock[] = [];
    if (turn.text !== undefined) {
      for (const word of turn.text.split(/(?<= )/)) yield { type: "text_delta", text: word };
      content.push({ type: "text", text: turn.text });
    }
    for (const [index, call] of (turn.toolCalls ?? []).entries()) {
      content.push({ type: "tool_use", id: call.id ?? `call_${this.next}_${index}`, name: call.name, input: call.input });
    }
    yield {
      type: "message",
      content,
      stopReason: turn.stopReason ?? (turn.toolCalls?.length ? "tool_use" : "end_turn"),
      usage: turn.usage ?? { inputTokens: 10, outputTokens: 5 },
    };
  }
}
