import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Send, Siren, Square, TriangleAlert, Wrench, X } from "lucide-react";

const endpoint = "/api/sports/emergency";

async function call(path, method = "GET", body) {
  const response = await fetch(endpoint + path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (response.status === 404 && !result.error) throw new Error("Emergency fix turns on the next time the desk restarts.");
  if (!response.ok) throw new Error(result.error || "The desk could not be reached. If the agent is restarting it, wait a minute.");
  return result;
}

// Emergency fix: chat with the Claude Code agent on the desk PC. It can change
// the app and restart it, so the warning stays on screen the whole time.
export function EmergencyFix() {
  const [open, setOpen] = useState(false);
  const [chat, setChat] = useState(null);
  const [enabled, setEnabled] = useState(true);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const log = useRef(null);

  const load = async (id = chat?.id) => {
    try {
      const view = await call(id ? `?id=${encodeURIComponent(id)}` : "");
      setEnabled(view.enabled !== false);
      setChat(view.chat);
      setError("");
    } catch (failure) {
      setError(failure.message);
    }
  };

  useEffect(() => {
    if (open) load();
  }, [open]);

  // Poll while the agent works. While the desk restarts the request fails;
  // the next poll picks the chat up again.
  useEffect(() => {
    if (!open || !chat?.running) return undefined;
    const timer = window.setInterval(() => load(chat.id), 2500);
    return () => window.clearInterval(timer);
  }, [open, chat?.id, chat?.running]);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [chat]);

  const send = async (event) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message || pending) return;
    setPending(true);
    try {
      const view = await call("", "POST", { message, id: chat?.id });
      setChat(view.chat);
      setDraft("");
      setError("");
    } catch (failure) {
      setError(failure.message);
    } finally {
      setPending(false);
    }
  };

  const stop = async () => {
    try {
      setChat((await call("/stop", "POST", { id: chat.id })).chat);
    } catch (failure) {
      setError(failure.message);
    }
  };

  return <>
    <button type="button" className="od-button od-emergency-button" onClick={() => setOpen(true)} aria-label="Emergency fix">
      <Siren size={14} /> <span className="od-emergency-label">Emergency fix</span>
    </button>
    {open && <div className="od-emergency-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <section className="od-emergency" role="dialog" aria-modal="true" aria-labelledby="od-emergency-title">
        <header className="od-emergency-head">
          <h2 id="od-emergency-title"><Wrench size={16} /> Emergency fix</h2>
          {chat && !chat.running && <button type="button" className="od-button od-button-quiet" onClick={() => { setChat(null); setDraft(""); }}>New chat</button>}
          <button type="button" className="od-notification-close" aria-label="Close" onClick={() => setOpen(false)}><X size={16} /></button>
        </header>
        <p className="od-emergency-warning" role="note">
          <TriangleAlert size={16} />
          <span><strong>Emergencies only.</strong> This talks to the Claude Code agent on the desk PC. It can change the app’s code
            and restart the live desk without asking. Restarting stops any build in progress. Use it when something is broken and you
            can’t get to the PC.</span>
        </p>
        <div className="od-emergency-log" ref={log} aria-live="polite">
          {!chat && <p className="od-emergency-empty">Describe what went wrong, for example: “Today’s build failed at the Shorts. Find out why, fix it and rebuild.”</p>}
          {chat?.turns.map((turn) => <div key={turn.n} className="od-emergency-turn">
            <div className="od-emergency-you">{turn.message}</div>
            {turn.items.map((item, index) => <div key={index} className={`od-emergency-item is-${item.kind}`}>{item.text}</div>)}
            {turn.running && <div className="od-emergency-item is-working"><LoaderCircle className="od-spin" size={14} /> Working…</div>}
          </div>)}
        </div>
        {error && <p className="od-emergency-error">{error}</p>}
        {!enabled ? <p className="od-emergency-error">The emergency agent is switched off on the desk PC (SPORTS_EMERGENCY_AGENT).</p> : (
          <form className="od-emergency-form" onSubmit={send}>
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={3} maxLength={8000}
              placeholder={chat?.running ? "The agent is working…" : "What’s wrong?"} disabled={pending || chat?.running}
              onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) send(event); }} />
            {chat?.running
              ? <button type="button" className="od-button" onClick={stop}><Square size={13} /> Stop</button>
              : <button type="submit" className="od-button od-emergency-send" disabled={pending || !draft.trim()}>
                {pending ? <LoaderCircle className="od-spin" size={14} /> : <Send size={14} />} Send
              </button>}
          </form>
        )}
      </section>
    </div>}
  </>;
}
