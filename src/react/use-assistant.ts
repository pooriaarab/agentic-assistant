import { useCallback, useEffect, useRef, useState } from "react";
import type { ToolRisk } from "../approvals.js";
import type { AssistantEvent, DoneReason } from "../loop.js";
import type { Message } from "../types.js";

export type PanelItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  | {
      kind: "tool";
      id: string;
      name: string;
      input: unknown;
      status: "running" | "waiting" | "done" | "failed" | "denied" | "not_run";
      /** Text a tool returned. It is data. Show it as text. */
      content?: string;
    }
  | {
      kind: "approval";
      id: string;
      tool: string;
      risk: Exclude<ToolRisk, "safe">;
      input: unknown;
      /** `expired`: the run ended before a decision was used. `unavailable`: the approval did not complete. */
      status: "pending" | "approved" | "declined" | "unavailable" | "expired";
      busy: boolean;
      decidedBy?: string;
    }
  | { kind: "notice"; id: string; text: string };

export interface UseAssistantOptions {
  /** Runs the assistant for this conversation. The host owns the model, the tools, and the principal. */
  run(messages: Message[], signal: AbortSignal): AsyncIterable<AssistantEvent>;
  /** Passes a person's decision to the approval gate. The host owns the gate and knows who the person is. */
  decide(requestId: string, approved: boolean, reason?: string): void | Promise<void>;
}

const STOP_NOTICES: Partial<Record<DoneReason, string>> = {
  max_turns: "The assistant stopped because it reached its step limit. Your messages are kept. Send a message to go on.",
  token_cap: "The assistant stopped because the conversation reached its size limit. Your messages are kept.",
  cost_cap: "The assistant stopped because it reached its cost limit. Your messages are kept.",
  max_tokens: "The answer was cut short because it was too long. Ask for a shorter answer.",
  refusal: "The model did not answer this request. Try to ask in another way.",
  provider_error: "The assistant could not get an answer from the model. Your messages are kept. Try again.",
  principal_inactive: "The assistant no longer has permission to act for you. Sign in again, then try again.",
  tool_call_cap: "The assistant tried to use too many tools at once, so it used none. Your messages are kept.",
  provider_stop: "The model stopped for a reason that is not known. Your messages are kept. Try again.",
  aborted: "You stopped the assistant. Your messages are kept.",
};

const RUN_FAILED = "The assistant could not finish. Your messages are kept. Try again, or contact support.";
const DECIDE_FAILED = "Your decision could not be sent. Nothing ran. Try again.";

export function useAssistant(options: UseAssistantOptions) {
  const [items, setItems] = useState<PanelItem[]>([]);
  const [running, setRunning] = useState(false);
  const history = useRef<Message[]>([]);
  const controller = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const counter = useRef(0);
  const latest = useRef(options);
  latest.current = options;

  const nextId = () => `item-${++counter.current}`;
  const add = (item: PanelItem) => setItems((current) => [...current, item]);
  const update = (id: string, change: (item: PanelItem) => PanelItem) =>
    setItems((current) => current.map((item) => (item.id === id ? change(item) : item)));

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (trimmed === "" || busy.current) return;
    busy.current = true;
    setRunning(true);
    const userMessage: Message = { role: "user", content: [{ type: "text", text: trimmed }] };
    add({ kind: "user", id: nextId(), text: trimmed });
    const abort = new AbortController();
    controller.current = abort;
    const sent = [...history.current, userMessage];
    let streamingId: string | null = null;
    let finished = false;
    const toolItems = new Map<string, string>();
    let lastToolItem: string | null = null;
    try {
      for await (const event of latest.current.run(sent, abort.signal)) {
        switch (event.type) {
          case "turn_start":
            streamingId = null;
            break;
          case "text_delta": {
            if (streamingId === null) {
              streamingId = nextId();
              add({ kind: "assistant", id: streamingId, text: event.text, streaming: true });
            } else {
              update(streamingId, (item) => (item.kind === "assistant" ? { ...item, text: item.text + event.text } : item));
            }
            break;
          }
          case "turn_end":
            if (streamingId !== null) update(streamingId, (item) => (item.kind === "assistant" ? { ...item, streaming: false } : item));
            streamingId = null;
            break;
          case "tool_call": {
            const id = nextId();
            toolItems.set(event.id, id);
            lastToolItem = id;
            add({ kind: "tool", id, name: event.name, input: event.input, status: "running" });
            break;
          }
          case "approval_request": {
            const { request } = event;
            add({ kind: "approval", id: request.id, tool: request.tool, risk: request.risk, input: request.input, status: "pending", busy: false });
            const waitingId = lastToolItem;
            if (waitingId !== null) update(waitingId, (item) => (item.kind === "tool" && item.status === "running" ? { ...item, status: "waiting" } : item));
            break;
          }
          case "approval_decision":
            update(event.requestId, (item) =>
              item.kind === "approval"
                ? {
                    ...item,
                    status: event.approved ? "approved" : event.reason === "the person declined" ? "declined" : "unavailable",
                    busy: false,
                    decidedBy: event.decidedBy,
                  }
                : item,
            );
            break;
          case "tool_result": {
            const id = toolItems.get(event.id);
            if (id !== undefined) {
              update(id, (item) =>
                item.kind === "tool"
                  ? { ...item, status: event.denied ? "denied" : event.isError ? "failed" : "done", content: event.content }
                  : item,
              );
            }
            break;
          }
          case "done": {
            finished = true;
            history.current = event.messages;
            const notice = STOP_NOTICES[event.reason];
            if (notice !== undefined) add({ kind: "notice", id: nextId(), text: notice });
            break;
          }
          default:
            break;
        }
      }
    } catch {
      add({ kind: "notice", id: nextId(), text: RUN_FAILED });
    } finally {
      if (!finished) history.current = sent;
      // A prompt or a card that the run left open can never finish. Say so.
      setItems((current) =>
        current.map((item) => {
          if (item.kind === "approval" && item.status === "pending") return { ...item, status: "expired", busy: false };
          if (item.kind === "tool" && (item.status === "running" || item.status === "waiting")) return { ...item, status: "not_run" };
          return item;
        }),
      );
      busy.current = false;
      controller.current = null;
      setRunning(false);
    }
  }, []);

  const stop = useCallback(() => controller.current?.abort(), []);

  // Closing the panel ends the run. Nothing keeps spending behind a closed panel.
  useEffect(() => () => controller.current?.abort(), []);

  /** Resolves true when the host took the decision, and false when it failed. */
  const decide = useCallback(async (requestId: string, approved: boolean, reason?: string): Promise<boolean> => {
    update(requestId, (item) => (item.kind === "approval" ? { ...item, busy: true } : item));
    try {
      await latest.current.decide(requestId, approved, reason);
      return true;
    } catch {
      update(requestId, (item) => (item.kind === "approval" ? { ...item, busy: false } : item));
      add({ kind: "notice", id: nextId(), text: DECIDE_FAILED });
      return false;
    }
  }, []);

  return { items, running, send, stop, decide };
}
