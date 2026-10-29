/** The demo page. One file, no outside requests: styles and script are inline and the CSP blocks everything else. */
export const DEMO_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export const DEMO_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agentic-assistant demo</title>
<style>
:root{color-scheme:light dark}
body{font:16px/1.5 system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem;color:var(--agd-color-text,CanvasText);background:var(--agd-color-surface,Canvas)}
label{display:block;margin-top:1rem;font-weight:600}
input,textarea,button{font:inherit;padding:.5rem;width:100%;box-sizing:border-box}
button{width:auto;min-height:2.5rem;margin-top:1rem;cursor:pointer}
:focus-visible{outline:3px solid var(--agd-color-focus,LinkText);outline-offset:2px}
#out{white-space:pre-wrap;border:1px solid var(--agd-color-border-strong,CanvasText);padding:1rem;margin-top:1rem;min-height:4rem}
.badge{display:inline-block;border:1px solid var(--agd-color-text,CanvasText);padding:0 .5rem;font-size:.875rem}
</style>
</head>
<body>
<main>
<h1>agentic-assistant demo</h1>
<p>Send a message to the hosted API. You need a bearer key. The key stays in this page and goes only to this Worker.</p>
<form id="f">
<label for="key">Bearer key</label>
<input id="key" type="password" autocomplete="off" required>
<label for="msg">Message</label>
<textarea id="msg" rows="3" required></textarea>
<button type="submit">Send</button>
</form>
<h2>Answer <span class="badge">AI-generated</span></h2>
<div id="out" role="log" aria-live="polite" aria-label="Assistant answer, AI-generated"></div>
</main>
<script>
const out = document.getElementById("out");
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  out.textContent = "";
  let res;
  try {
    res = await fetch("/api/v1/chat", {
      method: "POST",
      headers: { authorization: "Bearer " + document.getElementById("key").value, "content-type": "application/json" },
      body: JSON.stringify({ message: document.getElementById("msg").value }),
    });
  } catch {
    out.textContent = "The request failed. Check the network and try again.";
    return;
  }
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    out.textContent = "Error " + res.status + ": " + (body.message || body.error || "request failed");
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf("\\n\\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block.split("\\n").find((l) => l.startsWith("data: "));
        if (!data) continue;
        let event;
        try { event = JSON.parse(data.slice(6)); } catch { continue; }
        if (event.type === "text_delta" && typeof event.text === "string") out.textContent += event.text;
        if (event.type === "error") { finished = true; out.textContent += "\\n[stopped: " + event.error + "]"; }
        if (event.type === "done") { finished = true; if (event.reason !== "end_turn") out.textContent += "\\n[stopped: " + event.reason + (event.error ? ", " + event.error : "") + "]"; }
      }
    }
  } catch {
    // The stream broke. The check below reports it.
  }
  if (!finished) out.textContent += "\\n[stopped: the connection closed before the answer was complete]";
});
</script>
</body>
</html>`;
