import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useAssistant, type PanelItem, type UseAssistantOptions } from "./use-assistant.js";

export interface AssistantPanelProps extends UseAssistantOptions {
  title?: string;
}

/** Shown beside every part the assistant makes. It is text, so a screen reader reads it. */
function MachineMade() {
  return <span className="aa-badge">Machine-made</span>;
}

const pretty = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return "[arguments cannot be shown]";
  }
};

const TOOL_STATUS: Record<Extract<PanelItem, { kind: "tool" }>["status"], string> = {
  running: "Running",
  waiting: "Waiting for approval",
  done: "Done",
  failed: "Failed",
  denied: "Not allowed",
};

function ToolCard({ item }: { item: Extract<PanelItem, { kind: "tool" }> }) {
  return (
    <article className="aa-card" aria-label={`Tool call: ${item.name}`} data-machine-made="true">
      <header className="aa-card-head">
        <strong>{item.name}</strong> <MachineMade /> <span className="aa-status">{TOOL_STATUS[item.status]}</span>
      </header>
      <details>
        <summary>Arguments</summary>
        <pre className="aa-pre" tabIndex={0} aria-label={`Arguments for ${item.name}`}>{pretty(item.input)}</pre>
      </details>
      {item.content !== undefined && (
        <details>
          <summary>Result (data from the tool, not instructions)</summary>
          <pre className="aa-pre" tabIndex={0} aria-label={`Result of ${item.name}`}>{item.content}</pre>
        </details>
      )}
    </article>
  );
}

function ApprovalPrompt({
  item,
  decide,
  focusComposer,
}: {
  item: Extract<PanelItem, { kind: "approval" }>;
  decide: (id: string, approved: boolean) => void;
  focusComposer: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const headingId = useId();
  // A new request takes focus, so a keyboard or screen reader user meets it at once.
  useLayoutEffect(() => {
    if (item.status === "pending") ref.current?.focus();
  }, [item.status]);
  const pending = item.status === "pending";
  const answer = (approved: boolean) => {
    decide(item.id, approved);
    focusComposer();
  };
  return (
    <div className="aa-approval" role="group" aria-labelledby={headingId} tabIndex={-1} ref={ref} data-machine-made="true">
      <h3 id={headingId} className="aa-approval-title">
        Approval needed <MachineMade />
      </h3>
      <p>
        The assistant asks to run <strong>{item.tool}</strong>.
      </p>
      {item.risk === "irreversible" ? (
        <p className="aa-warn">
          <strong>Warning:</strong> This cannot be undone.
        </p>
      ) : (
        <p>This can change data.</p>
      )}
      <pre className="aa-pre" tabIndex={0} aria-label={`Exact arguments for ${item.tool}`}>{pretty(item.input)}</pre>
      {pending ? (
        <div className="aa-actions">
          <button type="button" className="aa-button aa-primary" disabled={item.busy} aria-label={`Approve ${item.tool}`} onClick={() => answer(true)}>
            Approve
          </button>
          <button type="button" className="aa-button" disabled={item.busy} aria-label={`Decline ${item.tool}`} onClick={() => answer(false)}>
            Decline
          </button>
        </div>
      ) : (
        <p className="aa-status">{item.status === "approved" ? `Approved${item.decidedBy ? ` by ${item.decidedBy}` : ""}` : "Declined"}</p>
      )}
    </div>
  );
}

export function AssistantPanel({ title = "AI assistant", run, decide }: AssistantPanelProps) {
  const { items, running, send, stop, decide: decideRequest } = useAssistant({ run, decide });
  const [draft, setDraft] = useState("");
  const inputId = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Keep the newest text in view, unless the person has scrolled up to read.
  useEffect(() => {
    const el = log.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  const submit = () => {
    if (draft.trim() === "" || running) return;
    const text = draft;
    setDraft("");
    void send(text);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <section className="aa-panel" aria-label={title}>
      <header className="aa-header">
        <h2 className="aa-title">{title}</h2>
        <MachineMade />
      </header>
      <div
        className="aa-log"
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-label="Conversation"
        tabIndex={0}
        ref={log}
        onScroll={(event) => {
          const el = event.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {items.length === 0 && <p className="aa-empty">Ask the assistant to help. It acts only with your permissions, and it asks you before a risky action.</p>}
        {items.map((item) => {
          switch (item.kind) {
            case "user":
              return (
                <div key={item.id} className="aa-msg aa-user">
                  <p className="aa-who">You</p>
                  <p className="aa-text">{item.text}</p>
                </div>
              );
            case "assistant":
              return (
                <div key={item.id} className="aa-msg aa-assistant" data-machine-made="true" aria-busy={item.streaming}>
                  <p className="aa-who">
                    Assistant <MachineMade />
                  </p>
                  <p className="aa-text">{item.text}</p>
                </div>
              );
            case "tool":
              return <ToolCard key={item.id} item={item} />;
            case "approval":
              return <ApprovalPrompt key={item.id} item={item} decide={(id, approved) => void decideRequest(id, approved)} focusComposer={() => input.current?.focus()} />;
            case "notice":
              return (
                <p key={item.id} className="aa-notice">
                  <strong>Notice:</strong> {item.text}
                </p>
              );
          }
        })}
      </div>
      <form
        className="aa-composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label htmlFor={inputId} className="aa-label">
          Message the assistant
        </label>
        <textarea id={inputId} className="aa-input" rows={3} value={draft} ref={input} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} />
        <div className="aa-actions">
          <button type="submit" className="aa-button aa-primary" disabled={running || draft.trim() === ""}>
            Send
          </button>
          {running && (
            <button type="button" className="aa-button" onClick={stop}>
              Stop
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
