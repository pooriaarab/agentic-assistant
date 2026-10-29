import {
  ProviderError,
  type ModelEvent,
  type ModelProvider,
  type ModelRequest,
  type Pricing,
  type Usage,
} from "../types.js";

type Final = Extract<ModelEvent, { type: "message" }>;

/**
 * Asks `primary`. When it refuses or fails, asks `fallback` once, with the same request.
 * The final message says which model answered. The fallback gets no second fallback: its
 * answer, its refusal, or its error is the result.
 *
 * Text from the first model is held until its turn ends, so a refused turn shows no text from
 * it. A turn with a fallback model configured therefore streams after the turn ends, not word by word.
 * Usage counts both asks. The price is the higher of the two, so a cost cap never counts too little.
 */
export class FallbackProvider implements ModelProvider {
  readonly name: string;
  readonly model: string;
  readonly pricing?: Pricing;

  constructor(
    private readonly primary: ModelProvider,
    private readonly fallback: ModelProvider,
  ) {
    this.name = primary.name;
    this.model = primary.model;
    // Without a price for both models, a cost cap cannot be enforced, and the loop refuses it.
    if (primary.pricing !== undefined && fallback.pricing !== undefined) {
      this.pricing = {
        inputPerMTok: Math.max(primary.pricing.inputPerMTok, fallback.pricing.inputPerMTok),
        outputPerMTok: Math.max(primary.pricing.outputPerMTok, fallback.pricing.outputPerMTok),
      };
    }
  }

  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    const held: ModelEvent[] = [];
    let final: Final | undefined;
    let failure: unknown;
    try {
      for await (const event of this.primary.stream(request)) {
        if (event.type === "message") final = event;
        else held.push(event);
      }
      if (final === undefined) throw new ProviderError(`provider "${this.primary.name}" ended without a final message`);
    } catch (error) {
      failure = error;
    }
    const answered = (provider: ModelProvider, fallbackFor?: "refusal" | "error") => ({
      provider: provider.name,
      model: provider.model,
      fallback: fallbackFor !== undefined,
      ...(fallbackFor !== undefined ? { fallbackFor } : {}),
    });
    if (failure === undefined && final !== undefined && final.stopReason !== "refusal") {
      for (const event of held) yield event;
      yield { ...final, answeredBy: answered(this.primary) };
      return;
    }
    // A stopped run must not start a second ask.
    if (failure !== undefined && request.signal?.aborted) throw failure;

    const spent: Usage = final?.usage ?? { inputTokens: 0, outputTokens: 0 };
    let second: Final | undefined;
    for await (const event of this.fallback.stream(request)) {
      if (event.type === "message") second = event;
      else yield event;
    }
    if (second === undefined) throw new ProviderError(`provider "${this.fallback.name}" ended without a final message`);
    yield {
      ...second,
      usage: {
        inputTokens: spent.inputTokens + second.usage.inputTokens,
        outputTokens: spent.outputTokens + second.usage.outputTokens,
      },
      answeredBy: answered(this.fallback, failure === undefined ? "refusal" : "error"),
    };
  }
}
