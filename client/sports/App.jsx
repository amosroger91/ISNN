import { useEffect, useRef, useState } from "react";
import {
  Activity, ArrowDownToLine, ArrowUpRight, CalendarDays, ChevronDown, CircleAlert,
  Clapperboard, Clock3, FileText, Film, LoaderCircle, MessageSquare, Moon, Pencil,
  Plus, Radio, RefreshCw, Send, SquarePlay, X,
} from "lucide-react";
import "./style.css";

const endpoint = "/api/sports";
const inProgress = (edition) => ["researching", "building"].includes(edition?.status)
  || edition?.publication?.status === "uploading";

async function request(path, method = "GET", body, signal) {
  const response = await fetch(endpoint + path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "The desk could not reach the server.");
  return result;
}

function editionDate(date) {
  if (!date) return "Today’s edition";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
}

function deskTime(time, timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric", minute: "2-digit", timeZone,
  }).format(new Date(time));
}

function timezoneLabel(date, timeZone) {
  const day = date ? new Date(`${date}T12:00:00Z`) : new Date();
  return new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortGeneric" })
    .formatToParts(day).find((part) => part.type === "timeZoneName")?.value || timeZone;
}

function externalUrl(text) {
  try {
    const url = new URL(text);
    if (["https:", "http:"].includes(url.protocol)) return url.href;
  } catch {}
  return undefined;
}

function Notice({ children, error = false }) {
  return (
    <div className={`od-notice${error ? " is-error" : ""}`} role={error ? "alert" : "status"}>
      {error ? <CircleAlert size={16} /> : <Radio size={16} />}
      <span>{children}</span>
    </div>
  );
}

function ScheduleItem({ icon: Icon, label, time, state, active, complete }) {
  return (
    <div className="od-schedule-item">
      <div className="od-schedule-icon"><Icon size={17} strokeWidth={1.8} /></div>
      <div>
        <div className="od-schedule-label">{label}</div>
        <strong>{time}</strong>
        <small className={active || complete ? "is-current" : ""}>
          {active ? <LoaderCircle className="od-spin" size={11} /> : <span className="od-dot" />}
          {state}
        </small>
      </div>
    </div>
  );
}

function EditionHeader({ edition, settings }) {
  const zone = timezoneLabel(edition?.date, settings?.timezone);
  const currentCut = edition?.render?.revision === edition?.revision && Boolean(edition?.render);
  const uploadState = edition?.publication?.status;
  const uploadLabel = {
    uploading: "Uploading", published: "Uploaded", failed: "Upload failed",
    held: "On hold", uncertain: "Check YouTube",
  }[uploadState] || (!settings?.youtubeConfigured ? "Setup needed" : settings?.publishEnabled ? "Scheduled" : "Paused");

  return (
    <section className="od-edition-header" aria-labelledby="od-title">
      <div className="od-edition-copy">
        <div className="od-edition-date"><CalendarDays size={14} />{editionDate(edition?.date)}</div>
        <h1 id="od-title">The Rundown</h1>
        <p>ISNN’s daily multi-sport recap</p>
      </div>
      <div className="od-schedule" aria-label="Daily production schedule">
        <ScheduleItem icon={Moon} label="Overnight research" time={`12:00 AM ${zone}`}
          state={edition?.status === "researching" ? "Researching" : edition?.researchedAt
            ? `Filed at ${deskTime(edition.researchedAt, settings?.timezone)}`
            : settings?.researchConfigured ? "Scheduled" : "Setup needed"}
          active={edition?.status === "researching"} complete={Boolean(edition?.researchedAt)} />
        <ScheduleItem icon={Clapperboard} label="Video production" time="After research"
          state={edition?.status === "building" ? "Building" : currentCut ? "Ready" : edition?.status === "failed" ? "Needs attention" : "Awaiting a cut"}
          active={edition?.status === "building"} complete={currentCut} />
        <ScheduleItem icon={SquarePlay} label="YouTube upload" time={`8:00 AM ${zone}`}
          state={uploadLabel} active={uploadState === "uploading"} complete={uploadState === "published"} />
      </div>
    </section>
  );
}

function TopicForm({ topic, pending, onSave, onClose }) {
  const [fields, setFields] = useState({
    title: topic?.title || "", summary: topic?.summary || "", take: topic?.take || "", url: "", excerpt: "",
  });
  const field = (key) => ({
    value: fields[key], onChange: (event) => setFields((old) => ({ ...old, [key]: event.target.value })),
  });
  return (
    <form className="od-topic-form" onSubmit={async (event) => {
      event.preventDefault();
      const values = { title: fields.title.trim(), summary: fields.summary.trim(), take: fields.take.trim() };
      if (values.title.length < 3) return;
      if (!topic && fields.url.trim()) values.url = fields.url.trim();
      if (!topic && fields.url.trim() && fields.excerpt.trim()) values.excerpt = fields.excerpt.trim();
      if (await onSave(values)) onClose();
    }}>
      <label>Headline<input required minLength={3} maxLength={160} {...field("title")} /></label>
      <label>Story notes<textarea rows={3} maxLength={1200} {...field("summary")} /></label>
      <label>Isaac’s take<textarea rows={3} maxLength={1800} {...field("take")} /></label>
      {!topic && <label>Source URL (optional)<input type="url" maxLength={1200} placeholder="https://" {...field("url")} /></label>}
      {!topic && fields.url.trim() && <label>Source excerpt<textarea rows={2} maxLength={1000} {...field("excerpt")} /></label>}
      <div className="od-form-actions">
        <button type="button" className="od-button od-button-quiet" onClick={onClose}>Cancel</button>
        <button type="submit" className="od-button od-button-accent" disabled={pending}>
          {pending && <LoaderCircle className="od-spin" size={14} />}
          {topic ? "Save changes" : "Add topic"}
        </button>
      </div>
    </form>
  );
}

function Sources({ sources }) {
  if (!sources.length) return <span className="od-source-empty"><FileText size={14} /> No sources attached</span>;
  return (
    <details className="od-sources">
      <summary><FileText size={14} /> {sources.length} {sources.length === 1 ? "source" : "sources"} <ChevronDown size={13} /></summary>
      <ul>
        {sources.map((source, index) => {
          const href = externalUrl(source.url);
          return (
            <li key={`${index}-${source.url}`}>
              {source.publisher && <span>{source.publisher}</span>}
              {href
                ? <a href={href} target="_blank" rel="noreferrer">{source.title || source.url} <ArrowUpRight size={13} /></a>
                : <strong>{source.title}</strong>}
              {source.excerpt && <p>{source.excerpt}</p>}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function TopicCard({ topic, editing, pending, locked, sample, onEdit, onClose, onSave, onChat }) {
  return (
    <article className={`od-topic${topic.selected ? " is-included" : ""}`}>
      <div className="od-topic-main">
        <header className="od-topic-head">
          <h3>{topic.title}</h3>
          <label className="od-check">
            <input type="checkbox" checked={topic.selected} disabled={pending || locked}
              aria-label={`Include ${topic.title} in the episode`} onChange={(event) => onSave({ selected: event.target.checked })} />
            <span>{topic.selected ? "Included" : "Excluded"}</span>
          </label>
        </header>
        {topic.summary && <p className="od-topic-summary">{topic.summary}</p>}
        {topic.take && <div className="od-take"><span>{sample ? "Editorial take" : "Isaac’s take"}</span><p>{topic.take}</p></div>}
        {editing && !locked && <TopicForm topic={topic} pending={pending} onSave={onSave} onClose={onClose} />}
      </div>
      <div className="od-topic-tools">
        <Sources sources={topic.sources || []} />
        {!locked && <div className="od-topic-actions">
          <button type="button" className="od-button od-button-quiet" onClick={onChat}>
            <MessageSquare size={14} /> Discuss
          </button>
          <button type="button" className="od-button od-button-quiet" onClick={editing ? onClose : onEdit}>
            {editing ? <X size={14} /> : <Pencil size={14} />} {editing ? "Close" : "Edit"}
          </button>
        </div>}
      </div>
    </article>
  );
}

function Chat({ edition, settings, topic, clearTopic, draft, setDraft, input, pending, locked, error, onDiscuss, onSend }) {
  const messages = edition?.messages || [];
  const lineup = edition?.topics || [];
  const list = useRef(null);
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [messages.length]);

  return (
    <section id="od-chat" className="od-chat od-panel" aria-labelledby="od-chat-title">
      <header className="od-chat-header">
        <span className="od-block-icon"><MessageSquare size={17} strokeWidth={1.8} /></span>
        <div>
          <h2 id="od-chat-title">Editorial chat</h2>
          <p>Talk through the lineup and add your takes.</p>
        </div>
      </header>
      <div ref={list} className="od-chat-scroll" aria-live="polite">
        <div className="od-chat-date"><span />{editionDate(edition?.date)}<span /></div>
        {(lineup.length > 0 || messages.length === 0) && (
          <div className="od-chat-message">
            <div className="od-chat-avatar"><Activity size={14} /></div>
            <div className="od-chat-content">
              <div className="od-chat-byline">
                <strong>Overtime Desk</strong>
                {edition?.researchedAt && <time dateTime={edition.researchedAt}>{deskTime(edition.researchedAt, settings?.timezone)}</time>}
              </div>
              {lineup.length === 0 ? <p>The lineup will appear here after overnight research.</p> : (
                <>
                  <p>{edition.sample ? "Practice lineup" : edition.researchedAt ? "Rundown after overnight research" : "Current lineup"}</p>
                  <ul className="od-chat-lineup">
                    {lineup.map((story) => <li key={story.id}>{locked ? story.title : (
                      <button type="button" onClick={() => onDiscuss(story)}>{story.title} <ArrowUpRight size={12} /></button>
                    )}</li>)}
                  </ul>
                </>
              )}
            </div>
          </div>
        )}
        {messages.map((message) => {
          const fromIsaac = ["user", "isaac", "editor"].includes(message.role);
          return (
            <div key={message.id} className={`od-chat-message${fromIsaac ? " is-isaac" : ""}`}>
              <div className="od-chat-avatar" aria-hidden="true">{fromIsaac ? "I" : <Activity size={14} />}</div>
              <div className="od-chat-content">
                <div className="od-chat-byline">
                  <strong>{fromIsaac ? "Isaac" : "Overtime Desk"}</strong>
                  {message.at && <time dateTime={message.at}>{deskTime(message.at, settings?.timezone)}</time>}
                </div>
                <p>{message.content}</p>
              </div>
            </div>
          );
        })}
      </div>
      {locked ? <div className="od-chat-form od-locked">This edition is locked for YouTube publishing.</div> : <form className="od-chat-form" onSubmit={async (event) => {
        event.preventDefault();
        if (!draft.trim()) return;
        if (await onSend(draft.trim())) setDraft("");
      }}>
        {error && <Notice error>{error}</Notice>}
        {topic && <div className="od-context">
          <span>{topic.title}</span><button type="button" aria-label="Clear topic" onClick={clearTopic}><X size={13} /></button>
        </div>}
        <div className="od-composer">
          <textarea ref={input} rows={2} aria-label="Message to the editorial desk"
            placeholder={topic ? "What’s your take on this story?" : "Message the editorial desk…"}
            value={draft} maxLength={2400} readOnly={pending} onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form.requestSubmit();
              }
            }} />
          <button type="submit" className="od-send" title="Send message" aria-label="Send message" disabled={pending || !draft.trim()}>
            {pending ? <LoaderCircle className="od-spin" size={17} /> : <Send size={16} />}
          </button>
        </div>
        <p>{settings?.researchConfigured
          ? topic ? "Edits from this message apply to the selected topic." : "Choose Discuss on a story to send a targeted edit."
          : topic ? "Try “take: …”, “title: …”, “summary: …”, “include”, or “exclude”." : "Try “add: …” or choose Discuss on a story to edit it."}</p>
      </form>}
    </section>
  );
}

function Episode({ edition, settings, pending, locked, onBuild }) {
  const building = edition?.status === "building";
  const render = edition?.render;
  const publication = edition?.publication;
  const publishedUrl = externalUrl(publication?.url);
  const stale = render && render.revision !== edition.revision;
  const readyToBuild = Boolean(edition?.topics?.some((topic) => topic.selected && (!edition.sample || topic.take)));
  const buildDisabled = pending || locked || inProgress(edition) || !(settings?.researchConfigured || edition?.sample) || !readyToBuild;
  const duration = Math.round(Number(render?.duration) || 0);
  const percent = edition?.progress?.percent;
  return (
    <section id="od-episode" className="od-episode" aria-labelledby="od-episode-title">
      <header className="od-section-heading">
        <div><h2 id="od-episode-title">Episode preview</h2><p>{stale ? "This cut is from an earlier draft." : "Review the cut and track the YouTube upload."}</p></div>
        <button type="button" className="od-button od-button-accent" onClick={onBuild} disabled={buildDisabled}>
          {building ? <LoaderCircle className="od-spin" size={15} /> : <Clapperboard size={15} />}
          {building ? "Building cut" : render ? "Rebuild video" : "Build video"}
        </button>
      </header>
      {edition?.error && <Notice error>{edition.error}</Notice>}
      {publication?.error && publication.error !== edition?.error && <Notice error>{publication.error}</Notice>}
      <div className="od-panel od-preview">
        {render?.url ? (
          <>
            <video key={render.url} preload="metadata" src={render.url} controls aria-label="Episode preview" />
            <div className="od-preview-meta">
              <div>
                <strong>{render.title}</strong>
                {!!duration && <span>{Math.floor(duration / 60)}:{String(duration % 60).padStart(2, "0")} runtime</span>}
              </div>
              <a className="od-button" href={render.url} download><ArrowDownToLine size={15} /> MP4</a>
            </div>
          </>
        ) : (
          <div className="od-preview-empty">
            {building ? <LoaderCircle className="od-spin" size={27} /> : <Film size={27} strokeWidth={1.5} />}
            <strong>{building ? "Rendering the episode" : "No video yet"}</strong>
            <p>{building ? (edition.progress?.message || "The preview will appear when the cut is ready.")
              : edition?.sample ? "Build the practice edition from the included takes."
                : "The overnight build uses the stories included in this rundown."}</p>
            {building && Number.isFinite(percent) && <progress aria-label="Video build progress" value={percent} max="100" />}
          </div>
        )}
        <div className="od-preview-footer">
          <div><SquarePlay size={17} /> {settings?.privacy
            ? `YouTube visibility · ${settings.privacy}` : "YouTube"}</div>
          {publishedUrl ? (
            <a href={publishedUrl} target="_blank" rel="noreferrer">Open on YouTube <ArrowUpRight size={15} /></a>
          ) : (
            <span>{(!settings?.youtubeConfigured && "Connection needed") || (!settings?.publishEnabled && "Scheduling paused") || "Daily at 8:00 AM"}</span>
          )}
        </div>
      </div>
    </section>
  );
}

export default function SportsApp() {
  const [view, setView] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState(null);
  const [pending, setPending] = useState("");
  const [editor, setEditor] = useState(null);
  const [target, setTarget] = useState(null);
  const [draft, setDraft] = useState("");
  const input = useRef(null);
  const mutation = useRef({ version: 0, active: false });
  const edition = view?.edition;
  const settings = view?.settings;
  const topics = edition?.topics || [];
  const isActive = inProgress(edition);
  const locked = edition?.locked ?? ["published", "uploading", "uncertain"].includes(edition?.publication?.status);
  const selectedTopic = topics.find((topic) => topic.id === target);
  const included = topics.filter((topic) => topic.selected).length;

  useEffect(() => {
    const previous = document.title;
    document.title = "The Rundown · Overtime Desk · ISNN";
    return () => { document.title = previous; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    const refresh = async () => {
      const { active, version } = mutation.current;
      if (active || loading) return;
      loading = true;
      try {
        const next = await request("/edition", "GET", undefined, controller.signal);
        if (version !== mutation.current.version || controller.signal.aborted) return;
        setView(next);
        setLoadError("");
      } catch (error) {
        if (version === mutation.current.version && !controller.signal.aborted) setLoadError(error.message);
      } finally {
        loading = false;
      }
    };
    refresh();
    const timer = window.setInterval(refresh, isActive ? 2500 : 20000);
    const refreshOnVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", refreshOnVisible);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshOnVisible);
    };
  }, [isActive]);

  async function mutate(path, method, payload, action) {
    if (mutation.current.active || locked) return false;
    mutation.current = { version: mutation.current.version + 1, active: true };
    setPending(action);
    setActionError(null);
    try {
      const next = await request(path, method, { ...payload, date: edition?.date });
      setView(next.edition ? next : await request("/edition"));
      setLoadError("");
      return true;
    } catch (error) {
      setActionError({ action, message: error.message });
      return false;
    } finally {
      mutation.current.active = false;
      setPending("");
    }
  }

  function discuss(topic) {
    setTarget(topic.id);
    document.getElementById("od-chat")?.scrollIntoView({ block: "nearest" });
    input.current?.focus({ preventScroll: true });
  }

  return (
    <div className="od">
      <header className="od-topbar">
        <div className="od-topbar-inner">
          <a className="od-brand" href="/sports" aria-label="Overtime Desk home">
            <span className="od-brand-icon"><Activity size={23} strokeWidth={2.4} /></span>
            <span>OVERTIME<span className="od-brand-desk"> DESK</span></span>
            <span className="od-brand-network">ISNN</span>
          </a>
          <nav aria-label="Desk navigation">
            <a href="#od-rundown">Rundown</a><a href="#od-chat">Chat</a><a href="#od-episode">Episode</a>
          </nav>
          <div className="od-editor-badge"><span aria-hidden="true">I</span> Isaac</div>
        </div>
      </header>
      <main className="od-workspace">
        <EditionHeader edition={edition} settings={settings} />
        {loadError && <Notice error>{loadError}</Notice>}
        {actionError && actionError.action !== "chat" && <Notice error>{actionError.message}</Notice>}
        {view && !settings?.researchConfigured && (
          <Notice>{edition?.sample ? "Practice edition. " : ""}Connect a research model to run the live overnight workflow.</Notice>
        )}
        <div className="od-work-grid">
          <section id="od-rundown" className="od-rundown" aria-labelledby="od-rundown-title">
            <header className="od-section-heading">
              <div>
                <h2 id="od-rundown-title">Story lineup</h2>
                {topics.length > 0 && <p>{included} of {topics.length} stories in the episode</p>}
              </div>
              {!locked && <div className="od-section-actions">
                {settings?.researchConfigured && (
                  <button type="button" className="od-button" disabled={Boolean(pending) || isActive}
                    onClick={() => mutate("/research", "POST", {}, "research")}>
                    <RefreshCw size={14} className={edition?.status === "researching" ? "od-spin" : ""} />
                    {edition?.status === "researching" ? "Researching" : "Run research"}
                  </button>
                )}
                <button type="button" className="od-button od-button-accent" disabled={!view || Boolean(pending)}
                  onClick={() => setEditor(editor === "new" ? null : "new")}><Plus size={16} /> Add topic</button>
              </div>}
            </header>
            {editor === "new" && !locked && (
              <div className="od-panel od-new-topic">
                <h3>Add a story</h3>
                <TopicForm pending={Boolean(pending)} onClose={() => setEditor(null)}
                  onSave={(fields) => mutate("/topics", "POST", fields, "topic")} />
              </div>
            )}
            {topics.length === 0 && (
              <div className="od-panel od-empty">
                {(!view && !loadError) || edition?.status === "researching" ? <LoaderCircle className="od-spin" size={20} /> : <Clock3 size={19} />}
                {edition?.status === "researching" ? "Researching the top stories…" : view ? "No topics have been filed for this edition." : loadError ? "The lineup is unavailable." : "Loading the lineup…"}
              </div>
            )}
            <div className="od-topic-list">
              {topics.map((topic) => (
                <TopicCard key={topic.id} topic={topic} editing={editor === topic.id}
                  pending={Boolean(pending)} locked={locked} sample={edition.sample}
                  onEdit={() => setEditor(topic.id)} onClose={() => setEditor(null)}
                  onSave={(fields) => mutate(`/topics/${encodeURIComponent(topic.id)}`, "PATCH", fields, "topic")}
                  onChat={() => discuss(topic)} />
              ))}
            </div>
          </section>
          <Chat edition={edition} settings={settings} topic={selectedTopic} clearTopic={() => setTarget(null)}
            draft={draft} setDraft={setDraft} input={input} pending={pending === "chat" || !view} locked={locked}
            error={actionError?.action === "chat" ? actionError.message : ""} onDiscuss={discuss}
            onSend={(message) => mutate("/chat", "POST", { message, ...(selectedTopic && { topicId: selectedTopic.id }) }, "chat")} />
          <Episode edition={edition} settings={settings} pending={Boolean(pending)} locked={locked}
            onBuild={() => mutate("/build", "POST", {}, "build")} />
        </div>
      </main>
    </div>
  );
}
