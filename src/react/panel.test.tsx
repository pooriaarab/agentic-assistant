// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { QueueApprovalGate, ToolRegistry, createPrincipal, runAssistant, type AssistantEvent, type Message, type ToolRisk } from "../index.js";
import { ScriptedProvider, type ScriptedTurn } from "../testing.js";
import { AssistantPanel } from "./index.js";

// Ways the panel can fail. Each one is a case below.
// 1. Streamed text does not show as it arrives, or shows twice.
// 2. A part the assistant made (message, tool card, approval) is not labeled machine-made, or a person's own message is.
// 3. Tool output or arguments render as HTML (a script or an image tag would run).
// 4. An approval prompt does not show the exact arguments or the risk, or has no accessible name.
// 5. A keyboard user cannot reach the prompt, or loses their place after a decision.
// 6. A double submit starts two runs. Enter does not send, or Shift+Enter does.
// 7. Stop does not abort the run. An error in the run leaves the panel stuck or loses the messages.
// 8. A failed decision hides the prompt, so the person cannot try again.
// 9. The next message does not carry the earlier conversation, or loses the message of a failed run.
// 10. A prompt stays clickable after its run ended (Stop, an error, closing the panel), or a stale card turns to waiting again.
// 11. A timeout or a gate failure shows as "Declined", as if a person refused.
// 12. Focus leaves the prompt when the decision did not go through. A double click sends two decisions.

afterEach(cleanup);

const actor = { principalId: "agent:a1", kind: "agent_of_human" as const, onBehalfOf: "human:alice", machineMade: true as const };
const done = (reason: Extract<AssistantEvent, { type: "done" }>["reason"] = "end_turn", messages: Message[] = []): AssistantEvent => ({
  type: "done",
  reason,
  totals: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  actor,
  messages,
});

/** A stream the test feeds by hand, so it can look at the page between events. */
class Feed implements AsyncIterable<AssistantEvent> {
  private queue: AssistantEvent[] = [];
  private waiting: ((result: IteratorResult<AssistantEvent>) => void) | undefined;
  private closed = false;
  push(event: AssistantEvent) {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: event, done: false });
    } else this.queue.push(event);
  }
  end() {
    this.closed = true;
    this.waiting?.({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<AssistantEvent> {
    return {
      next: () => {
        const event = this.queue.shift();
        if (event) return Promise.resolve({ value: event, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiting = resolve));
      },
    };
  }
}

const noDecide = () => undefined;

function realAssistant(script: ScriptedTurn[], tools: { name: string; risk: ToolRisk; result?: string }[]) {
  const gate = new QueueApprovalGate();
  const registry = new ToolRegistry();
  for (const tool of tools) {
    registry.register({
      name: tool.name,
      description: "d",
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
      scope: "notes:write",
      risk: tool.risk,
      handler: () => tool.result ?? "ok",
    });
  }
  const provider = new ScriptedProvider(script);
  const principal = createPrincipal({ id: "agent:a1", kind: "agent_of_human", parentId: "human:alice", scopes: ["notes:write"] });
  return {
    gate,
    run: (messages: Message[], signal: AbortSignal) => runAssistant({ provider, registry, principal, messages, approvals: gate, signal }),
    decide: (id: string, approved: boolean, reason?: string) => (approved ? gate.approve(id, "human:alice") : gate.reject(id, "human:alice", reason)),
  };
}

const composer = () => screen.getByRole("textbox", { name: "Message the assistant" });

describe("assistant panel", () => {
  test("streams text as it arrives, and labels it machine-made", async () => {
    const feed = new Feed();
    const user = userEvent.setup();
    const { container } = render(<AssistantPanel run={() => feed} decide={noDecide} />);
    await user.type(composer(), "hello{Enter}");
    expect(await screen.findByText("hello")).toBeTruthy();
    feed.push({ type: "turn_start", turn: 1 });
    feed.push({ type: "text_delta", text: "Hel" });
    expect(await screen.findByText("Hel")).toBeTruthy();
    feed.push({ type: "text_delta", text: "lo there" });
    expect(await screen.findByText("Hello there")).toBeTruthy();
    expect(container.querySelectorAll(".aa-assistant")).toHaveLength(1);
    expect(container.querySelector(".aa-assistant")?.getAttribute("aria-busy")).toBe("true");
    feed.push({ type: "turn_end", turn: 1, usage: { inputTokens: 1, outputTokens: 1 }, totals: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, answeredBy: { provider: "scripted", model: "scripted-1", fallback: false } });
    feed.push(done());
    feed.end();
    await waitFor(() => expect(container.querySelector(".aa-assistant")?.getAttribute("aria-busy")).toBe("false"));
    expect(within(container.querySelector(".aa-assistant") as HTMLElement).getByText("Machine-made")).toBeTruthy();
    expect(container.querySelector(".aa-user")?.textContent).not.toContain("Machine-made");
  });

  test("shows a tool card with its arguments and result as text, never as HTML", async () => {
    const payload = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
    const { run, decide } = realAssistant([{ toolCalls: [{ name: "notes_read", input: { id: "n1" } }] }, { text: "Done." }], [{ name: "notes_read", risk: "safe", result: payload }]);
    const user = userEvent.setup();
    const { container } = render(<AssistantPanel run={run} decide={decide} />);
    await user.type(composer(), "read it{Enter}");
    const card = await screen.findByRole("article", { name: "Tool call: notes_read" });
    await within(card).findByText("Done");
    expect(within(card).getByText("Machine-made")).toBeTruthy();
    expect(within(card).getByLabelText("Arguments for notes_read").textContent).toContain('"id": "n1"');
    expect(within(card).getByLabelText("Result of notes_read").textContent).toContain(payload);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  test("asks before a risky action, shows the exact arguments, and moves focus", async () => {
    const { run, decide, gate } = realAssistant([{ toolCalls: [{ name: "notes_write", input: { id: "n9" } }] }, { text: "Saved." }], [{ name: "notes_write", risk: "risky" }]);
    const user = userEvent.setup();
    const { container } = render(<AssistantPanel run={run} decide={decide} />);
    await user.type(composer(), "write it{Enter}");
    const prompt = await screen.findByRole("group", { name: /Approval needed/ });
    expect(document.activeElement).toBe(prompt);
    expect(within(prompt).getByLabelText("Exact arguments for notes_write").textContent).toContain('"id": "n9"');
    expect(within(prompt).getByText("Machine-made")).toBeTruthy();
    expect(within(prompt).getByText("This can change data.")).toBeTruthy();
    expect(gate.pending()).toHaveLength(1);
    await user.click(within(prompt).getByRole("button", { name: "Approve notes_write" }));
    await screen.findByText("Saved.");
    expect(within(container.querySelector(".aa-approval") as HTMLElement).getByText("Approved by human:alice")).toBeTruthy();
    expect(document.activeElement).toBe(composer());
    expect(gate.pending()).toHaveLength(0);
  });

  test("a declined action does not run, and says so", async () => {
    const handler = vi.fn(() => "ran");
    const gate = new QueueApprovalGate();
    const registry = new ToolRegistry().register({ name: "notes_write", description: "d", inputSchema: { type: "object" }, scope: "notes:write", risk: "risky", handler });
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "notes_write", input: {} }] }, { text: "Not done." }]);
    const principal = createPrincipal({ id: "agent:a1", kind: "agent_of_human", parentId: "human:alice", scopes: ["notes:write"] });
    const user = userEvent.setup();
    render(
      <AssistantPanel
        run={(messages, signal) => runAssistant({ provider, registry, principal, messages, approvals: gate, signal })}
        decide={(id, approved) => (approved ? gate.approve(id, "human:alice") : gate.reject(id, "human:alice"))}
      />,
    );
    await user.type(composer(), "go{Enter}");
    await user.click(await screen.findByRole("button", { name: "Decline notes_write" }));
    await screen.findByText("Not done.");
    expect(handler).not.toHaveBeenCalled();
    const card = screen.getByRole("article", { name: "Tool call: notes_write" });
    expect(within(card).getByText("Not allowed")).toBeTruthy();
    expect(screen.getByText("Declined")).toBeTruthy();
  });

  test("warns in text when an action cannot be undone", async () => {
    const { run, decide } = realAssistant([{ toolCalls: [{ name: "notes_purge", input: {} }] }, { text: "ok" }], [{ name: "notes_purge", risk: "irreversible" }]);
    const user = userEvent.setup();
    render(<AssistantPanel run={run} decide={decide} />);
    await user.type(composer(), "purge{Enter}");
    const prompt = await screen.findByRole("group", { name: /Approval needed/ });
    expect(within(prompt).getByText("Warning:")).toBeTruthy();
    expect(prompt.textContent).toContain("This cannot be undone.");
  });

  test("labels every part the assistant made, and none of the person's own", async () => {
    const { run, decide, gate } = realAssistant(
      [{ text: "Plan. ", toolCalls: [{ name: "notes_write", input: { id: "a" } }] }, { text: "Finished." }],
      [{ name: "notes_write", risk: "risky" }],
    );
    const user = userEvent.setup();
    const { container } = render(<AssistantPanel run={run} decide={decide} />);
    await user.type(composer(), "go{Enter}");
    await user.click(await screen.findByRole("button", { name: "Approve notes_write" }));
    await screen.findByText("Finished.");
    void gate;
    const made = container.querySelectorAll('[data-machine-made="true"]');
    expect(made.length).toBeGreaterThanOrEqual(4);
    for (const element of made) expect(within(element as HTMLElement).getAllByText("Machine-made").length).toBeGreaterThan(0);
    expect(container.querySelectorAll(".aa-assistant, article.aa-card, .aa-approval")).toHaveLength(made.length);
    for (const own of container.querySelectorAll(".aa-user")) expect(own.textContent).not.toContain("Machine-made");
  });

  test("Enter sends, Shift+Enter adds a line, an empty message is not sent, and a double submit runs once", async () => {
    const feed = new Feed();
    const run = vi.fn(() => feed);
    const user = userEvent.setup();
    render(<AssistantPanel run={run} decide={noDecide} />);
    await user.type(composer(), "{Enter}");
    expect(run).not.toHaveBeenCalled();
    await user.type(composer(), "a{Shift>}{Enter}{/Shift}b");
    expect((composer() as HTMLTextAreaElement).value).toBe("a\nb");
    await user.type(composer(), "{Enter}");
    await user.type(composer(), "second{Enter}");
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    feed.push(done());
    feed.end();
  });

  test("Stop aborts the run and says so", async () => {
    let signalSeen: AbortSignal | undefined;
    const run = (_messages: Message[], signal: AbortSignal) =>
      (async function* () {
        signalSeen = signal;
        await new Promise((resolve) => signal.addEventListener("abort", resolve));
        yield done("aborted");
      })();
    const user = userEvent.setup();
    render(<AssistantPanel run={run} decide={noDecide} />);
    await user.type(composer(), "long task{Enter}");
    await user.click(await screen.findByRole("button", { name: "Stop" }));
    expect(signalSeen?.aborted).toBe(true);
    expect(await screen.findByText(/You stopped the assistant/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  test("an error in the run keeps the messages and frees the composer", async () => {
    const run = () =>
      (async function* (): AsyncGenerator<AssistantEvent> {
        throw new Error("network down");
      })();
    const user = userEvent.setup();
    render(<AssistantPanel run={run} decide={noDecide} />);
    await user.type(composer(), "hi{Enter}");
    expect(await screen.findByText(/could not finish/)).toBeTruthy();
    expect(screen.getByText("hi")).toBeTruthy();
    await user.type(composer(), "again");
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("a cut-off answer is not left marked as busy, and a stream with no end says so", async () => {
    const feed = new Feed();
    const user = userEvent.setup();
    const { container } = render(<AssistantPanel run={() => feed} decide={noDecide} />);
    await user.type(composer(), "go{Enter}");
    feed.push({ type: "turn_start", turn: 1 });
    feed.push({ type: "text_delta", text: "Here is" });
    await screen.findByText("Here is");
    expect(container.querySelector(".aa-assistant")?.getAttribute("aria-busy")).toBe("true");
    feed.end();
    expect(await screen.findByText(/could not finish/)).toBeTruthy();
    expect(container.querySelector(".aa-assistant")?.getAttribute("aria-busy")).toBe("false");
  });

  test("a decision that is not a clear yes or no is not shown as a decline", async () => {
    const gate = { request: async (request: { id: string }) => ({ requestId: request.id, approved: undefined }) as never };
    const registry = new ToolRegistry().register({ name: "notes_write", description: "d", inputSchema: { type: "object" }, scope: "notes:write", risk: "risky", handler: () => "ran" });
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "notes_write", input: {} }] }, { text: "ok" }]);
    const principal = createPrincipal({ id: "agent:a1", kind: "agent_of_human", parentId: "human:alice", scopes: ["notes:write"] });
    const user = userEvent.setup();
    render(<AssistantPanel run={(messages, signal) => runAssistant({ provider, registry, principal, messages, approvals: gate, signal })} decide={noDecide} />);
    await user.type(composer(), "go{Enter}");
    expect(await screen.findByText(/Not approved\. The approval did not complete/)).toBeTruthy();
    expect(screen.queryByText("Declined")).toBeNull();
  });

  test("a cap or an error stop shows a notice in plain words", async () => {
    const run = () => (async function* () { yield done("max_turns"); })();
    const user = userEvent.setup();
    render(<AssistantPanel run={run} decide={noDecide} />);
    await user.type(composer(), "x{Enter}");
    expect(await screen.findByText(/reached its step limit/)).toBeTruthy();
  });

  test("a decision that fails shows a notice and keeps the prompt open", async () => {
    const { run } = realAssistant([{ toolCalls: [{ name: "notes_write", input: {} }] }, { text: "ok" }], [{ name: "notes_write", risk: "risky" }]);
    const user = userEvent.setup();
    render(<AssistantPanel run={run} decide={() => Promise.reject(new Error("offline"))} />);
    await user.type(composer(), "go{Enter}");
    await user.click(await screen.findByRole("button", { name: "Approve notes_write" }));
    expect(await screen.findByText(/decision could not be sent/)).toBeTruthy();
    await waitFor(() => expect((screen.getByRole("button", { name: "Approve notes_write" }) as HTMLButtonElement).disabled).toBe(false));
  });

  test("the next message carries the earlier conversation", async () => {
    const seen: number[] = [];
    const run = (messages: Message[]) =>
      (async function* () {
        seen.push(messages.length);
        yield done("end_turn", [...messages, { role: "assistant", content: [{ type: "text", text: "reply" }] }]);
      })();
    const user = userEvent.setup();
    render(<AssistantPanel run={run} decide={noDecide} />);
    await user.type(composer(), "one{Enter}");
    await waitFor(() => expect(seen).toEqual([1]));
    await user.type(composer(), "two{Enter}");
    await waitFor(() => expect(seen).toEqual([1, 3]));
  });

  test("Stop during a pending approval closes the prompt and marks the card", async () => {
    const { run, decide, gate } = realAssistant([{ toolCalls: [{ name: "notes_write", input: {} }] }, { text: "ok" }], [{ name: "notes_write", risk: "risky" }]);
    const user = userEvent.setup();
    render(<AssistantPanel run={run} decide={decide} />);
    await user.type(composer(), "go{Enter}");
    await screen.findByRole("button", { name: "Approve notes_write" });
    await user.click(screen.getByRole("button", { name: "Stop" }));
    await screen.findByText(/You stopped the assistant/);
    expect(screen.queryByRole("button", { name: "Approve notes_write" })).toBeNull();
    expect(screen.getByText(/Expired/)).toBeTruthy();
    expect(within(screen.getByRole("article", { name: "Tool call: notes_write" })).getByText("Not run")).toBeTruthy();
    expect(gate.pending()).toEqual([]);
  });

  test("an error in the run closes a pending prompt", async () => {
    const feed = new Feed();
    const user = userEvent.setup();
    render(<AssistantPanel run={() => feed} decide={noDecide} />);
    await user.type(composer(), "go{Enter}");
    feed.push({ type: "tool_call", id: "c1", name: "notes_write", input: {}, actor });
    feed.push({ type: "approval_request", request: { id: "r1", tool: "notes_write", risk: "risky", input: {}, digest: "d", actor } });
    await screen.findByRole("button", { name: "Approve notes_write" });
    feed.end();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Approve notes_write" })).toBeNull());
    expect(screen.getByText(/Expired/)).toBeTruthy();
  });

  test("a stale card does not wait for approval again in a later run", async () => {
    const feeds = [new Feed(), new Feed()];
    let call = 0;
    const user = userEvent.setup();
    render(<AssistantPanel run={() => feeds[call++] as Feed} decide={noDecide} />);
    const ask = (feed: Feed, id: string) => {
      feed.push({ type: "tool_call", id, name: "notes_write", input: {}, actor });
      feed.push({ type: "approval_request", request: { id: `r-${id}`, tool: "notes_write", risk: "risky", input: {}, digest: "d", actor } });
    };
    await user.type(composer(), "one{Enter}");
    ask(feeds[0] as Feed, "c1");
    await screen.findByRole("button", { name: "Approve notes_write" });
    await user.click(screen.getByRole("button", { name: "Stop" }));
    feeds[0]?.push(done("aborted"));
    feeds[0]?.end();
    await screen.findByText(/You stopped the assistant/);
    await user.type(composer(), "two{Enter}");
    ask(feeds[1] as Feed, "c2");
    await screen.findByRole("button", { name: "Approve notes_write" });
    expect(screen.getAllByText("Waiting for approval")).toHaveLength(1);
    expect(screen.getAllByText("Not run")).toHaveLength(1);
    feeds[1]?.end();
  });

  test("a timeout or a gate failure does not read as a person's decline", async () => {
    const gate = { request: () => new Promise<never>(() => undefined) };
    const registry = new ToolRegistry().register({ name: "notes_write", description: "d", inputSchema: { type: "object" }, scope: "notes:write", risk: "risky", handler: () => "ran" });
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "notes_write", input: {} }] }, { text: "ok" }]);
    const principal = createPrincipal({ id: "agent:a1", kind: "agent_of_human", parentId: "human:alice", scopes: ["notes:write"] });
    const user = userEvent.setup();
    render(
      <AssistantPanel
        run={(messages, signal) => runAssistant({ provider, registry, principal, messages, approvals: gate, signal, limits: { approvalTimeoutMs: 100 } })}
        decide={noDecide}
      />,
    );
    await user.type(composer(), "go{Enter}");
    expect(await screen.findByText(/Not approved\. The approval did not complete/)).toBeTruthy();
    expect(screen.queryByText("Declined")).toBeNull();
  });

  test("closing the panel aborts the run", async () => {
    let signalSeen: AbortSignal | undefined;
    const feed = new Feed();
    const user = userEvent.setup();
    const { unmount } = render(<AssistantPanel run={(_m, signal) => ((signalSeen = signal), feed)} decide={noDecide} />);
    await user.type(composer(), "long{Enter}");
    await waitFor(() => expect(signalSeen).toBeDefined());
    unmount();
    expect(signalSeen?.aborted).toBe(true);
    feed.end();
  });

  test("a decision that fails keeps focus in the prompt, and a double click sends one decision", async () => {
    const { run } = realAssistant([{ toolCalls: [{ name: "notes_write", input: {} }] }, { text: "ok" }], [{ name: "notes_write", risk: "risky" }]);
    const decide = vi.fn(() => new Promise<void>((_, reject) => setTimeout(() => reject(new Error("offline")), 30)));
    const user = userEvent.setup();
    render(<AssistantPanel run={run} decide={decide} />);
    await user.type(composer(), "go{Enter}");
    const approve = await screen.findByRole("button", { name: "Approve notes_write" });
    await user.dblClick(approve);
    await screen.findByText(/decision could not be sent/);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(composer());
  });

  test("a failed run still carries the person's message into the next run", async () => {
    const seen: number[] = [];
    let first = true;
    const run = (messages: Message[]) =>
      (async function* (): AsyncGenerator<AssistantEvent> {
        seen.push(messages.length);
        if (first) {
          first = false;
          throw new Error("down");
        }
        yield done();
      })();
    const user = userEvent.setup();
    render(<AssistantPanel run={run} decide={noDecide} />);
    await user.type(composer(), "one{Enter}");
    await screen.findByText(/could not finish/);
    await user.type(composer(), "two{Enter}");
    await waitFor(() => expect(seen).toEqual([1, 2]));
  });

  test("has named landmarks, a live log, and labeled controls", () => {
    render(<AssistantPanel run={() => new Feed()} decide={noDecide} title="Notes helper" />);
    expect(screen.getByRole("region", { name: "Notes helper" })).toBeTruthy();
    const log = screen.getByRole("log", { name: "Conversation" });
    expect(log.getAttribute("aria-live")).toBe("polite");
    expect(log.getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("heading", { level: 2, name: /Notes helper/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    expect(composer().tagName).toBe("TEXTAREA");
  });
});
