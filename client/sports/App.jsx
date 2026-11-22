import { useEffect, useRef, useState } from "react";
import { DAILY_STORY_TARGET, MAX_EPISODE_STORIES, PREFERRED_SHORTS_COUNT } from "../../shared/sports-limits.mjs";
import {
  Activity, ArrowDownToLine, ArrowUpRight, BellRing, CalendarDays, ChevronDown, CircleAlert,
  Clapperboard, Clock3, FileText, Film, Gavel, LoaderCircle, MessageSquare, Moon, Pencil,
  Plus, Radio, RefreshCw, ScanSearch, Send, ShieldCheck, SquarePlay, Target, ThumbsUp, TrendingUp, X,
} from "lucide-react";
import { CalendarTab, dueLabel } from "./Calendar.jsx";
import { CommentsTab } from "./Comments.jsx";
import { ListenWithRoger } from "./Listen.jsx";
import { EmergencyFix } from "./Emergency.jsx";
import "./style.css";
import wellspringLogo from "../../assets/wellspring-media-logo.png";

const endpoint = "/api/sports";
const uploadingSlot = (slot) => slot?.status === "uploading";
const inProgress = (edition) => ["researching", "building"].includes(edition?.status)
  || edition?.publication?.status === "uploading"
  || uploadingSlot(edition?.youtube?.episode)
  || Object.values(edition?.youtube?.shorts || {}).some(uploadingSlot);

function episodeUploadState(edition) {
  const manual = edition?.youtube?.episode;
  const publication = edition?.publication || {};
  if (["published", "uploading", "uncertain"].includes(manual?.status)) return manual;
  if (["published", "uploading", "uncertain"].includes(publication.status)) return publication;
  if (edition?.locked && publication.status === "failed") return { ...publication, held: true };
  return manual || { status: "pending" };
}

function YoutubeButton({ slot, pending, disabled, blocked, onClick }) {
  const url = externalUrl(slot?.url);
  if (slot?.status === "published" && url) {
    return <a className="od-button" href={url} target="_blank" rel="noreferrer">On YouTube <ArrowUpRight size={14} /></a>;
  }
  if (slot?.status === "uploading") {
    return <button type="button" className="od-button" disabled><LoaderCircle className="od-spin" size={14} /> Uploading</button>;
  }
  const retry = slot?.status === "failed";
  const held = slot?.held || slot?.status === "uncertain";
  const reason = blocked || (held ? slot.error || "Check YouTube Studio before retrying." : null);
  return (
    <div className="od-youtube-action">
      <button type="button" className="od-button" disabled={disabled || held || Boolean(blocked)} title={reason || undefined} onClick={onClick}>
        {pending ? <LoaderCircle className="od-spin" size={14} /> : <SquarePlay size={14} />}
        {pending ? "Starting upload" : retry ? "Retry YouTube upload" : "Upload to YouTube now"}
      </button>
      {reason && <small>{reason}</small>}
    </div>
  );
}

function youtubeSlots(edition) {
  return [
    ["scheduled", "Recap", edition.publication],
    ["episode", "Recap", edition.youtube?.episode],
    ...Object.entries(edition.youtube?.shorts || {}).map(([segment, slot]) => [`short-${segment}`, `Short ${segment}`, slot]),
  ];
}

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

function commentSummary(comments) {
  if (!comments || comments.status === "idle" || comments.status === "running") return null;
  if (comments.status === "failed" && !comments.replied && !comments.liked) {
    return { error: true, message: comments.error || "YouTube comment replies failed." };
  }
  const parts = [];
  if (comments.replied) parts.push(`replied to ${comments.replied}`);
  if (comments.liked) parts.push(`liked ${comments.liked}`);
  let message = parts.length ? `YouTube comments: ${parts.join(" and ")}.` : "YouTube comments are caught up.";
  if (comments.remaining) message += ` ${comments.remaining} still open. Click again to continue.`;
  if (comments.likesUnsupported) message += comments.unliked ? ` ${comments.unliked} comments still need a like in YouTube Studio.` : " Apply comment likes in YouTube Studio.";
  if (comments.failed) message += ` ${comments.failed} could not be updated.`;
  if (comments.status === "failed" && comments.error) message += ` ${comments.error}`;
  return { error: comments.status === "failed" || comments.failed > 0, message };
}

function commentTitle(settings, comments) {
  if (!settings?.youtubeConfigured) return "Add YouTube OAuth credentials before checking comments.";
  if (!settings?.researchConfigured) return "Connect a model before replying to comments.";
  if (comments?.status === "running") return "Checking comments on every video.";
  if (comments?.remaining) return `${comments.remaining} comments are still open. Click again to continue.`;
  return "Reply to unanswered comments across the channel and count comments that still need a like.";
}

function externalUrl(text) {
  try {
    const url = new URL(text);
    if (["https:", "http:"].includes(url.protocol)) return url.href;
  } catch {}
  return undefined;
}

// Claims as the desk shows them: evidence resolved to the snapshot's URL and provider.
function publicClaims(ledger) {
  const snapshots = Object.fromEntries((ledger.snapshots || []).map((snapshot) => [snapshot.id, snapshot]));
  return (ledger.claims || []).map((claim) => ({
    ...claim,
    evidence: (claim.evidence || []).map((item) => ({ ...item, url: snapshots[item.snapshotId]?.sourceUrl || null, provider: snapshots[item.snapshotId]?.provider || null })),
  }));
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
        <p>Daily multi-sport recap with Isaac Doss</p>
      </div>
      <div className="od-schedule" aria-label="Daily production schedule">
        <ScheduleItem icon={Moon} label="Evening research" time={`9:00 PM ${zone}`}
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

// Sport and league choices for manual entries come from the desk's coverage
// scope (NCAA, NBA and MLB at launch), so nothing outside it can be tagged.
const SPORT_LABELS = { basketball: "Basketball", football: "Football", baseball: "Baseball", hockey: "Hockey", soccer: "Soccer", mma: "MMA", other: "Other news" };
const sportLabel = (sport) => SPORT_LABELS[sport] || sport || "";
function scopeChoices(scope) {
  const options = scope?.options || [];
  const sports = [...new Set(options.map(({ sport }) => sport))];
  return { sports, leaguesFor: (sport) => options.filter((option) => option.sport === sport) };
}

// What the story is about, readable at a glance: sport, league and the teams.
function SportTags({ topic }) {
  if (!topic.sport && !topic.league && !topic.teams?.length && !topic.scheduled) return null;
  return (
    <div className="od-tags" aria-label="Sport, league and teams">
      {topic.scheduled && <span className="od-tag od-scheduled-tag" title="Scheduled ahead of time on the calendar">From the calendar</span>}
      {topic.sport && <span className={`od-tag is-${topic.sport}`}>{sportLabel(topic.sport)}</span>}
      {topic.league && topic.sport !== "other" && <span className="od-tag is-league">{topic.league}</span>}
      {(topic.teams || []).map((team) => <span key={team} className="od-tag is-teams">{team}</span>)}
    </div>
  );
}

function TopicForm({ topic, category, scope, modelConfigured, pending, onSave, onClose }) {
  const [fields, setFields] = useState({
    title: topic?.title || "", summary: topic?.summary || "", take: topic?.take || "", takeScript: topic?.takeScript || "", url: "", excerpt: "", clipUrl: topic?.clipUrl || "",
    sport: topic?.sport || category || "", league: topic?.league || (category === "other" ? "Other news" : ""), teams: (topic?.teams || []).join(", "),
  });
  const field = (key) => ({
    value: fields[key], onChange: (event) => setFields((old) => ({ ...old, [key]: event.target.value })),
  });
  const { sports, leaguesFor } = scopeChoices(scope);
  const leagues = leaguesFor(fields.sport);
  const notesChanged = fields.take.trim() !== (topic?.take || "");
  const scriptTyped = fields.takeScript.trim() !== (topic?.takeScript || "") && Boolean(fields.takeScript.trim());
  // A script Isaac types airs exactly as written; only notes alone are drafted.
  const draftsOnSave = modelConfigured && notesChanged && Boolean(fields.take.trim()) && !scriptTyped;
  return (
    <form className="od-topic-form" onSubmit={async (event) => {
      event.preventDefault();
      const values = { title: fields.title.trim(), summary: fields.summary.trim(), take: fields.take.trim() };
      if (values.title.length < 3) return;
      values.sport = fields.sport || null;
      values.league = fields.sport === "other" ? "Other news" : fields.league.trim() || null;
      values.teams = fields.sport === "other" ? [] : [...new Set(fields.teams.split(",").map((team) => team.trim()).filter((team) => team.length >= 2))].slice(0, 6);
      if (!topic && fields.url.trim()) values.url = fields.url.trim();
      if (!topic && fields.url.trim() && fields.excerpt.trim()) values.excerpt = fields.excerpt.trim();
      if (fields.clipUrl.trim() !== (topic?.clipUrl || "")) values.clipUrl = fields.clipUrl.trim();
      if (fields.takeScript.trim() !== (topic?.takeScript || "")) values.takeScript = fields.takeScript.trim();
      if (event.nativeEvent.submitter?.value === "draft-take") values.draftTake = true;
      const saved = await onSave(values);
      if (!saved) return;
      const updated = topic && saved.edition.topics.find(({ id }) => id === topic.id);
      // A take script drafts in the background, so the form closes once the
      // story is saved; without a model it stays open to write the script.
      if (updated && !updated.takeDraftingAt && notesChanged && !modelConfigured) {
        setFields((old) => ({ ...old, take: updated.take, takeScript: updated.takeScript || "" }));
      } else onClose();
    }}>
      <div className="od-form-row">
        <label>Category
          <select value={fields.sport} onChange={(event) => setFields((old) => ({ ...old, sport: event.target.value, league: event.target.value === "other" ? "Other news" : leaguesFor(event.target.value).some(({ league }) => league === old.league) ? old.league : "" }))}>
            <option value="">Choose a category</option>
            {sports.map((value) => <option key={value} value={value}>{sportLabel(value)}</option>)}
          </select>
        </label>
        {fields.sport !== "other" && <label>League
          <select value={fields.league} disabled={!fields.sport} onChange={(event) => setFields((old) => ({ ...old, league: event.target.value }))}>
            <option value="">Choose a league</option>
            {leagues.map(({ league, label }) => <option key={league} value={league}>{label}</option>)}
          </select>
        </label>}
      </div>
      {scope?.label && <p className="od-form-hint">{fields.sport === "other" ? "Any non-sports subject. Add a source link and excerpt for reported facts, or save a take for commentary." : `Sports coverage: ${scope.label}. Choose Other news for non-sports stories.`}</p>}
      {fields.sport !== "other" && <label>Teams covered<input maxLength={300} placeholder="Comma separated; leave empty for a general topic" {...field("teams")} /><CharCount value={fields.teams} max={300} /></label>}
      <label>Headline<input required minLength={3} maxLength={160} {...field("title")} /><CharCount value={fields.title} max={160} /></label>
      <label>Story notes<textarea rows={3} maxLength={1200} {...field("summary")} /><CharCount value={fields.summary} max={1200} /></label>
      <label>Isaac’s take notes<textarea rows={3} maxLength={1800} placeholder="A rough angle, what you noticed, or what to watch next" {...field("take")} /><CharCount value={fields.take} max={1800} /></label>
      {draftsOnSave && <p className="od-form-hint">Saving files the story now; the on-air script drafts in the background.</p>}
      <label>Isaac’s on-air script (optional)
        <textarea rows={5} maxLength={1200} disabled={pending} placeholder="Type exactly what Isaac should say. It airs as written: no source or fact check needed." {...field("takeScript")} /><CharCount value={fields.takeScript} max={1200} />
      </label>
      {!topic && <label>Source URL (optional)<input type="url" maxLength={1200} placeholder="https://" {...field("url")} /><CharCount value={fields.url} max={1200} /></label>}
      {!topic && fields.url.trim() && <label>Source excerpt<textarea rows={2} maxLength={1000} {...field("excerpt")} /><CharCount value={fields.excerpt} max={1000} /></label>}
      <label>Game footage or archival B-roll (optional)
        <input type="url" maxLength={1200} placeholder="YouTube video or Wikimedia Commons File page" {...field("clipUrl")} /><CharCount value={fields.clipUrl} max={1200} />
      </label>
      <div className="od-form-actions">
        <button type="button" className="od-button od-button-quiet" onClick={onClose}>Cancel</button>
        {modelConfigured && topic?.take && !notesChanged && (
          <button type="submit" value="draft-take" className="od-button" disabled={pending}>{topic.takeScript ? "Redraft take script" : "Draft take script"}</button>
        )}
        <button type="submit" className="od-button od-button-accent" disabled={pending}>
          {pending && <LoaderCircle className="od-spin" size={14} />}
          {draftsOnSave ? "Save and draft" : topic ? "Save changes" : "Add topic"}
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

// The Check trend scorecard: the four components, the recommendation and why.
function TrendCard({ trend }) {
  if (!trend) return null;
  const tone = trend.airable ? " is-go" : trend.recommendation === "signal unavailable" ? " is-warn" : "";
  const filtered = [...new Set(trend.filtered.map(({ reason }) => reason))];
  return (
    <div className={`od-trend${tone}`} aria-label="Trend scorecard">
      <div className="od-trend-head">
        <TrendingUp size={14} /><strong>{trend.recommendation}</strong><span>{trend.score} / 100</span>
        {trend.scope === "out" && <em>out of scope</em>}
      </div>
      <ul className="od-trend-parts">
        {Object.entries(trend.components).map(([part, value]) => <li key={part}><span>{part}</span><strong>{value}</strong></li>)}
      </ul>
      {trend.query && <p>“{trend.query}” via {trend.providers.join(", ") || "no provider"} · {trend.comparison.qualifying} qualifying of {trend.comparison.observations} observations</p>}
      {trend.explanation.map((line) => <p key={line}>{line}</p>)}
      {trend.missing.length > 0 && <p className="od-trend-note">Missing: {trend.missing.join("; ")}.</p>}
      {filtered.length > 0 && <p className="od-trend-note">Filtered: {filtered.join(", ")}.</p>}
    </div>
  );
}

// Characters used against the field's limit, shown with every text field.
function CharCount({ value, max }) {
  const used = String(value ?? "").length;
  return <small className={`od-count${used >= max ? " is-full" : ""}`}>{used.toLocaleString()} / {max.toLocaleString()}</small>;
}

function CorrectionForm({ claim, pending, onSubmit, onClose }) {
  const [fields, setFields] = useState({ text: claim.text, value: Array.isArray(claim.value) ? claim.value.join(", ") : claim.value ?? "", url: "", locator: "", excerpt: "", reason: "" });
  const field = (key) => ({ value: fields[key], onChange: (event) => setFields((old) => ({ ...old, [key]: event.target.value })) });
  return (
    <form className="od-topic-form od-correction" onSubmit={async (event) => {
      event.preventDefault();
      const numbers = fields.value.split(",").map((part) => part.trim()).filter(Boolean).map(Number);
      const payload = { text: fields.text.trim(), evidence: { url: fields.url.trim(), locator: fields.locator.trim(), excerpt: fields.excerpt.trim() || undefined }, reason: fields.reason.trim() };
      if (numbers.length && numbers.every(Number.isFinite)) payload.value = numbers.length === 1 ? numbers[0] : numbers;
      if (await onSubmit(payload)) onClose();
    }}>
      <label>Corrected claim<input required minLength={3} maxLength={300} {...field("text")} /><CharCount value={fields.text} max={300} /></label>
      <label>Value (numbers, comma separated)<input maxLength={80} {...field("value")} /><CharCount value={fields.value} max={80} /></label>
      <label>Evidence URL<input required type="url" maxLength={1200} placeholder="https://" {...field("url")} /><CharCount value={fields.url} max={1200} /></label>
      <label>Locator in that source<input required maxLength={160} placeholder="Stat correction, line score, 4th quarter 0:41…" {...field("locator")} /><CharCount value={fields.locator} max={160} /></label>
      <label>Excerpt<textarea rows={2} maxLength={1000} {...field("excerpt")} /><CharCount value={fields.excerpt} max={1000} /></label>
      <label>Reason<input required minLength={3} maxLength={400} {...field("reason")} /><CharCount value={fields.reason} max={400} /></label>
      <div className="od-form-actions">
        <button type="button" className="od-button od-button-quiet" onClick={onClose}>Cancel</button>
        <button type="submit" className="od-button od-button-accent" disabled={pending}>{pending && <LoaderCircle className="od-spin" size={14} />} Supersede claim</button>
      </div>
    </form>
  );
}

function ResolveForm({ pending, onSubmit }) {
  const [reason, setReason] = useState("");
  const decide = async (disposition) => {
    if (reason.trim().length < 3) return;
    if (await onSubmit({ disposition, reason: reason.trim() })) setReason("");
  };
  return (
    <div className="od-resolve">
      <input aria-label="Ruling reason" placeholder="Why this evidence wins" maxLength={400} value={reason} onChange={(event) => setReason(event.target.value)} />
      <CharCount value={reason} max={400} />
      <button type="button" className="od-button od-button-accent" disabled={pending} onClick={() => decide("supported")}><Gavel size={13} /> Confirm</button>
      <button type="button" className="od-button od-button-quiet" disabled={pending} onClick={() => decide("withheld")}>Withhold</button>
    </div>
  );
}

// The claims behind a story: evidence locators, dispositions, and Isaac's
// controls to correct a claim or rule on a conflict.
// Highlight clips discovered on the story's event: a public page, a length and
// the restrictions ESPN published. Isaac approves a source range or rejects
// the clip. Nothing here downloads; a granted file is a separate operator step.
function Clips({ topic, locked, pending, onReview }) {
  const [ranges, setRanges] = useState({});
  const list = topic.clips || [];
  if (!list.length) return null;
  const range = (clip) => ranges[clip.id] || { in: clip.in ?? 0, out: clip.out ?? Math.min(8, clip.duration || 8) };
  const setRange = (clip, key, value) => setRanges((old) => ({ ...old, [clip.id]: { ...range(clip), [key]: Number(value) } }));
  return (
    <details className="od-sources od-clips">
      <summary><Film size={14} /> {list.length} {list.length === 1 ? "clip reference" : "clip references"} <ChevronDown size={13} /></summary>
      <ul>
        {list.map((clip) => {
          const href = externalUrl(clip.page);
          const current = range(clip);
          return (
            <li key={clip.id} className={`od-clip${clip.decision ? ` is-${clip.decision}` : ""}`}>
              <strong>{clip.headline}</strong>
              <small>
                {clip.duration ? `${Math.round(clip.duration)} s` : "length unknown"} · {clip.source}
                {clip.embargo && Date.parse(clip.embargo) > Date.now() ? ` · embargoed until ${new Date(clip.embargo).toLocaleString()}` : ""}
                {clip.expiration ? ` · expires ${new Date(clip.expiration).toLocaleDateString()}` : ""}
                {href && <> · <a href={href} target="_blank" rel="noreferrer">public page <ArrowUpRight size={12} /></a></>}
                {clip.decision && <> · <em>{clip.decision}{clip.decision === "approved" ? ` ${clip.in}–${clip.out} s` : ""}</em></>}
              </small>
              {!locked && (
                <div className="od-clip-review">
                  <label>In<input type="number" min={0} step={0.5} max={clip.duration || 3600} value={current.in} onChange={(event) => setRange(clip, "in", event.target.value)} /></label>
                  <label>Out<input type="number" min={0} step={0.5} max={clip.duration || 3600} value={current.out} onChange={(event) => setRange(clip, "out", event.target.value)} /></label>
                  <button type="button" className="od-button od-button-accent" disabled={pending} onClick={() => onReview(clip.id, { decision: "approved", ...current })}>Approve range</button>
                  <button type="button" className="od-button od-button-quiet" disabled={pending} onClick={() => onReview(clip.id, { decision: "rejected" })}>Reject</button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="od-clips-note">References only. A clip reaches the cut when an operator drops a granted file for this event into the footage folder.</p>
    </details>
  );
}

function Claims({ topic, claims, locked, pending, onCorrect, onResolve }) {
  const [correcting, setCorrecting] = useState(null);
  const list = (topic.claimIds || []).map((id) => claims?.[id]).filter(Boolean);
  if (!list.length) return null;
  return (
    <details className="od-sources od-claims">
      <summary><ShieldCheck size={14} /> {list.length} {list.length === 1 ? "claim" : "claims"} · {topic.coverage || "unverified"} <ChevronDown size={13} /></summary>
      {topic.coverageReason && <p className="od-claims-reason">{topic.coverageReason}</p>}
      <ul>
        {list.map((claim) => (
          <li key={claim.id} className={`od-claim is-${claim.disposition}`}>
            <span className="od-claim-state">{claim.disposition}{claim.reason ? ` · ${claim.reason}` : ""}</span>
            <strong>{claim.text}</strong>
            <small>{claim.evidence.map((item, index) => {
              const href = externalUrl(item.url);
              return <span key={`${item.id}-${index}`}>{href ? <a href={href} target="_blank" rel="noreferrer">{item.provider || "source"}</a> : item.provider || "source"} · {item.locator}{item.stance === "contradicts" ? " · contradicts" : ""}</span>;
            })}</small>
            {!locked && claim.disposition === "conflict" && <ResolveForm pending={pending} onSubmit={(fields) => onResolve(claim.id, fields)} />}
            {!locked && claim.disposition === "supported" && correcting !== claim.id && (
              <button type="button" className="od-link" onClick={() => setCorrecting(claim.id)}>Correct this claim</button>
            )}
            {correcting === claim.id && <CorrectionForm claim={claim} pending={pending} onSubmit={(fields) => onCorrect(claim.id, fields)} onClose={() => setCorrecting(null)} />}
          </li>
        ))}
      </ul>
    </details>
  );
}

// A draft older than 20 minutes was lost (a restart); show the notes as needing a script.
const takeDrafting = (topic) => Boolean(topic.takeDraftingAt) && Date.now() - Date.parse(topic.takeDraftingAt) < 20 * 60_000;

function TopicCard({ topic, claims, scope, modelConfigured, editing, pending, locked, isCore, onEdit, onClose, onSave, onChat, onTrend, onCore, onCorrect, onResolve, onClip }) {
  return (
    <article className={`od-topic${topic.selected ? " is-included" : ""}${isCore ? " is-core" : ""}`}>
      <div className="od-topic-main">
        <header className="od-topic-head">
          <h3>{isCore && <Target size={15} aria-label="Core story" />} {topic.title}</h3>
          <label className="od-check">
            <input type="checkbox" checked={topic.selected} disabled={pending || locked}
              aria-label={`Include ${topic.title} in the episode`} onChange={(event) => onSave({ selected: event.target.checked })} />
            <span>{topic.selected ? "Included" : "Excluded"}</span>
          </label>
        </header>
        <SportTags topic={topic} />
        {topic.eventId && <p className="od-topic-meta">{topic.eventId}{topic.coverage ? ` · ${topic.coverage}` : ""}</p>}
        {topic.skipReason && <p className="od-topic-skip">{topic.skipReason}</p>}
        {topic.summary && <p className="od-topic-summary">{topic.summary}</p>}
        {topic.script && <p className="od-topic-script">{topic.script.narration}</p>}
        {!editing && topic.takeScript && <div className="od-take"><span>On-air take script</span><p>{topic.takeScript}</p></div>}
        {!editing && topic.take && !topic.takeScript && <div className="od-take"><span className={!takeDrafting(topic) && topic.takeError ? "is-error" : undefined}>Take notes · {takeDrafting(topic) ? "Drafting the on-air script…" : topic.takeError ? `${topic.takeError} Choose Edit, then Draft take script to try again.` : "Script needed"}</span><p>{topic.take}</p></div>}
        <TrendCard trend={topic.trend} />
        {editing && !locked && <TopicForm topic={topic} scope={scope} modelConfigured={modelConfigured} pending={pending} onSave={onSave} onClose={onClose} />}
      </div>
      <div className="od-topic-tools">
        <div className="od-topic-evidence">
          <Sources sources={topic.sources || []} />
          <Claims topic={topic} claims={claims} locked={locked} pending={pending} onCorrect={onCorrect} onResolve={onResolve} />
          <Clips topic={topic} locked={locked} pending={pending} onReview={onClip} />
        </div>
        {!locked && <div className="od-topic-actions">
          <button type="button" className="od-button od-button-quiet" disabled={pending} onClick={onTrend} title="Score attention on this story">
            <TrendingUp size={14} /> Check trend
          </button>
          <button type="button" className={`od-button od-button-quiet${isCore ? " is-active" : ""}`} disabled={pending} onClick={onCore} title="Lock as the episode's core story">
            <Target size={14} /> {isCore ? "Core story" : "Make core"}
          </button>
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

// Coverage of the scanned slate: which games are covered, which await
// verification, and which sources were unavailable.
function Slate({ slate, lastScan, timeZone }) {
  if (!slate?.length) return null;
  return (
    <details className="od-panel od-slate">
      <summary><ScanSearch size={15} /> Slate scan · {slate.length} games{lastScan ? ` · ${deskTime(lastScan.at, timeZone)} via ${lastScan.provider}` : ""} <ChevronDown size={13} /></summary>
      <table>
        <thead><tr><th>League</th><th>Game</th><th>Status</th><th>Coverage</th><th>Claims</th></tr></thead>
        <tbody>
          {slate.map((row) => (
            <tr key={row.gameId} className={`is-${row.coverage.replaceAll(" ", "-")}`}>
              <td>{row.league}</td>
              <td>{row.title}</td>
              <td>{row.status}</td>
              <td>{row.coverage}{row.reason ? <small>{row.reason}</small> : null}</td>
              <td>{row.supported}/{row.claims}{row.independentOrigins ? <small>{row.independentOrigins} origins</small> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function TrendDesk({ trendDesk, topics, timeZone }) {
  if (!trendDesk?.checks?.length && !trendDesk?.coreTopicId) return null;
  const core = topics.find(({ id }) => id === trendDesk.coreTopicId);
  return (
    <div className="od-panel od-trenddesk">
      <h3><TrendingUp size={15} /> Trend desk</h3>
      <p>{core ? <>Core story: <strong>{core.title}</strong>{trendDesk.lockedAt ? ` · locked ${deskTime(trendDesk.lockedAt, timeZone)}` : ""}</> : "No core story locked. Angles score against their own story until Isaac locks one."}</p>
      {trendDesk.checks?.length > 0 && (
        <ul>
          {trendDesk.checks.map((check) => (
            <li key={check.topicId} className={check.airable ? "is-go" : ""}>
              <strong>{check.score}</strong> {check.recommendation} · {check.title}{check.query ? ` (“${check.query}”)` : ""} · {deskTime(check.checkedAt, timeZone)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Chat({ edition, settings, topic, clearTopic, draft, setDraft, input, pending, locked, error, onDiscuss, onSend }) {
  const messages = edition?.messages || [];
  const lineup = edition?.topics || [];
  const list = useRef(null);
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [messages.length, pending]);

  return (
    <section id="od-chat" className="od-chat od-panel" aria-labelledby="od-chat-title">
      <header className="od-chat-header">
        <span className="od-block-icon"><MessageSquare size={17} strokeWidth={1.8} /></span>
        <div>
          <h2 id="od-chat-title">Editorial chat</h2>
          <p>Ask what’s happening, add stories, and edit the rundown.</p>
        </div>
      </header>
      <div ref={list} className="od-chat-scroll" aria-live="polite">
        <div className="od-chat-date"><span />{editionDate(edition?.date)}<span /></div>
        {(lineup.length > 0 || messages.length === 0) && (
          <div className="od-chat-message">
            <div className="od-chat-avatar"><Activity size={14} /></div>
            <div className="od-chat-content">
              <div className="od-chat-byline">
                <strong>Wellspring Media Sports</strong>
                {edition?.researchedAt && <time dateTime={edition.researchedAt}>{deskTime(edition.researchedAt, settings?.timezone)}</time>}
              </div>
              {lineup.length === 0 ? <p>The lineup will appear here after overnight research.</p> : (
                <>
                  <p>{edition.sample ? "Practice lineup" : edition.researchedAt ? "Rundown after overnight research" : "Current lineup"}</p>
                  <ul className="od-chat-lineup">
                    {lineup.map((story) => <li key={story.id}>
                      {story.league && <span className="od-lineup-league">{story.league}</span>}
                      <button type="button" onClick={() => onDiscuss(story)}>{story.title} <ArrowUpRight size={12} /></button>
                    </li>)}
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
                  <strong>{fromIsaac ? "Isaac" : "Wellspring Media Sports"}</strong>
                  {message.at && <time dateTime={message.at}>{deskTime(message.at, settings?.timezone)}</time>}
                </div>
                <p>{message.content}</p>
              </div>
            </div>
          );
        })}
      </div>
      <form className="od-chat-form" onSubmit={async (event) => {
        event.preventDefault();
        if (!draft.trim()) return;
        if (await onSend(draft.trim())) setDraft("");
      }}>
        {error && <Notice error>{error}</Notice>}
        <div className="od-chat-suggestions" aria-label="Chat suggestions">
          {["What’s going on?", "What’s in the lineup?", ...(topic ? ["What sources support this story?"] : [])].map((prompt) => (
            <button key={prompt} type="button" disabled={pending} onClick={() => { setDraft(prompt); input.current?.focus(); }}>{prompt}</button>
          ))}
        </div>
        {topic && <div className="od-context">
          <span>{topic.title}</span><button type="button" aria-label="Clear topic" onClick={clearTopic}><X size={13} /></button>
        </div>}
        <div className="od-composer">
          <textarea ref={input} rows={2} aria-label="Message to the editorial desk"
            placeholder={locked ? "Ask about this edition…" : topic ? "Ask about or edit this story…" : "Ask a question, add a story, or describe an edit…"}
            value={draft} maxLength={2400} readOnly={pending} onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form.requestSubmit();
              }
            }} />
          <CharCount value={draft} max={2400} />
          <button type="submit" className="od-send" title="Send message" aria-label="Send message" disabled={pending || !draft.trim()}>
            {pending ? <LoaderCircle className="od-spin" size={17} /> : <Send size={16} />}
          </button>
        </div>
        <p>{locked ? "Questions are available. Open a new revision to edit this published edition." : settings?.researchConfigured
          ? topic ? "Questions use this story’s reporting. Requested edits save to the rundown." : "Name a story or choose Discuss to target it. Non-sports stories can go in Other news."
          : topic ? "Try “take: …”, “title: …”, “summary: …”, “include”, or “exclude”." : "Try “add: …” or choose Discuss on a story to edit it."}</p>
      </form>
    </section>
  );
}

function Corrections({ corrections, timeZone }) {
  if (!corrections?.length) return null;
  return (
    <div className="od-corrections" role="status">
      {corrections.slice(-3).reverse().map((item) => (
        <p key={item.id}>
          <CircleAlert size={14} /> <strong>Correction {deskTime(item.at, timeZone)}</strong>: “{item.previousText}” is superseded by “{item.text}”. {item.reason}
          {item.invalidatedRevision !== null && item.invalidatedRevision !== undefined ? ` Revision ${item.invalidatedRevision} was withdrawn; rebuild to air the corrected copy.` : ""}
          {item.topics?.length ? ` Affects: ${item.topics.map(({ title }) => title).join("; ")}.` : ""}
        </p>
      ))}
    </div>
  );
}

function Shots({ shots }) {
  const rows = (shots || []).filter(Boolean);
  if (!rows.length) return null;
  const describe = (shot) => shot.use ? `clip ${shot.use} (${shot.grant}, audio ${shot.audio})` : `${shot.fallback}${shot.reasons?.length ? ` · ${shot.reasons.map(({ reason }) => reason).join("; ")}` : ""}`;
  return (
    <ul className="od-shots" aria-label="Rights decisions per segment">
      {rows.map((row) => <li key={row.segment}><span>{String(row.segment).padStart(2, "0")}</span> Episode: {describe(row.episode)} · Short: {describe(row.short)}</li>)}
    </ul>
  );
}

// What the anchor actually said in this cut, per story, with how it was produced.
function AnchorScript({ anchor }) {
  if (!anchor?.segments?.length) return null;
  const label = { written: "anchor copy", cached: "anchor copy", fallback: "factual draft" };
  return (
    <details className="od-anchor">
      <summary><FileText size={14} /> Anchor script · {anchor.segments.length} {anchor.segments.length === 1 ? "story" : "stories"}{anchor.status === "fallback" ? " · model unavailable, drafts aired" : ""} <ChevronDown size={13} /></summary>
      {anchor.issues?.length > 0 && <p className="od-anchor-issue">{anchor.issues.join(" ")}</p>}
      <ol>
        {anchor.segments.map((segment) => (
          <li key={segment.id}>
            <strong>{segment.headline}</strong> <span className={`od-anchor-status is-${segment.status}`}>{label[segment.status] || segment.status}</span>
            <p>{segment.narration}</p>
          </li>
        ))}
      </ol>
    </details>
  );
}

function buildProgress(edition) {
  const message = edition?.progress?.message || "";
  const recorded = /Recording Isaac \((\d+) of (\d+)\)/u.exec(message);
  if (recorded) {
    const index = Number(recorded[1]);
    const total = Number(recorded[2]);
    return { message, percent: 8 + Math.round(((index - 1) / Math.max(total, 1)) * 42) };
  }
  const percent = edition?.progress?.percent;
  return { message, percent: Number.isFinite(percent) ? percent : null };
}

const PHONE_VERIFY = "Verify the channel's phone number in YouTube Studio to enable custom thumbnails.";

function thumbnailSrc(edition, target) {
  const render = edition?.render;
  if (!render?.thumbnails || render.revision == null) return "";
  const relative = target === "episode" ? render.thumbnails.episode : render.thumbnails.shorts?.[String(target)];
  if (!relative) return "";
  return `${endpoint}/thumbnail/${edition.date}/${render.revision}/${target}?cut=${render.build || ""}`;
}

function thumbnailLine(edition, target) {
  const listing = edition?.render?.listing;
  if (target === "episode") return listing?.episode?.thumbnail || "";
  return listing?.shorts?.find((short) => short.segment === target)?.thumbnail || "";
}

function ThumbnailNote({ slot }) {
  const thumbnail = slot?.thumbnail;
  if (!thumbnail) return null;
  if (thumbnail.status === "set") return <small className="od-thumb-note">Thumbnail on YouTube</small>;
  if (thumbnail.status === "unavailable") return <small className="od-thumb-note">{PHONE_VERIFY}</small>;
  if (thumbnail.status === "failed") return <small className="od-thumb-note">{thumbnail.error || "Thumbnail failed"}</small>;
  return null;
}

function ThumbnailLine({ initial, pending, onUpdate, onRedraw }) {
  const [line, setLine] = useState(initial || "");
  useEffect(() => { setLine(initial || ""); }, [initial]);
  return (
    <form className="od-thumb-line" onSubmit={(event) => { event.preventDefault(); onUpdate(line); }}>
      <input aria-label="Thumbnail line" value={line} maxLength={80} placeholder="2 to 4 words"
        onChange={(event) => setLine(event.target.value)} />
      <CharCount value={line} max={80} />
      <button type="submit" className="od-button" disabled={pending}>Update line</button>
      <button type="button" className="od-button" disabled={pending} onClick={onRedraw}>
        <RefreshCw size={14} /> Regenerate
      </button>
    </form>
  );
}

function Episode({ edition, settings, pending, locked, onBuild, onUpload, onUploadAll, onRegenerate }) {
  const building = edition?.status === "building";
  const render = edition?.render;
  const publication = edition?.publication;
  const publishedUrl = externalUrl(publication?.url);
  const stale = render && render.revision !== edition.revision;
  const readyToBuild = Boolean(edition?.topics?.some((topic) => topic.selected && (!edition.sample || topic.takeScript || topic.script)));
  const buildDisabled = pending || (locked && edition?.publication?.status !== "published") || inProgress(edition) || !(settings?.researchConfigured || edition?.sample) || !readyToBuild;
  const availability = edition?.uploadAvailability;
  const uploadDisabled = Boolean(pending) || inProgress(edition) || stale || edition?.sample || !render?.url
    || edition?.status !== "ready" || !settings?.youtubeConfigured || Boolean(availability?.reason);
  const episodeSlot = episodeUploadState(edition);
  // Videos in this cut that are not on YouTube yet and not held back.
  const settled = (slot) => ["published", "uploading", "uncertain"].includes(slot?.status) || slot?.held;
  const waitingUploads = (settled(episodeSlot) || availability?.episode ? 0 : 1) + (render?.shorts || []).filter((short) =>
    !settled(edition?.youtube?.shorts?.[String(short.segment)]) && !availability?.[short.segment]).length;
  const episodeThumb = thumbnailSrc(edition, "episode");
  const thumbnailUnavailable = edition?.youtube?.thumbnailHalt?.reason === "unavailable"
    || edition?.publication?.thumbnail?.status === "unavailable"
    || episodeSlot?.thumbnail?.status === "unavailable"
    || Object.values(edition?.youtube?.shorts || {}).some((slot) => slot?.thumbnail?.status === "unavailable");
  const duration = Math.round(Number(render?.duration) || 0);
  const progress = buildProgress(edition);
  const uploadErrors = [
    episodeSlot?.status === "failed" ? episodeSlot.error : null,
    ...Object.entries(edition?.youtube?.shorts || {}).flatMap(([segment, slot]) => (
      slot?.status === "failed" && slot.error ? [`Short ${segment}: ${slot.error}`] : []
    )),
  ].filter((error) => error && error !== edition?.error && error !== publication?.error);
  return (
    <section id="od-episode" className="od-episode" aria-labelledby="od-episode-title">
      <header className="od-section-heading">
        <div><h2 id="od-episode-title">Episode preview</h2><p>{stale ? "This cut is from an earlier draft." : "Review the cut and track the YouTube upload."}</p></div>
        <button type="button" className="od-button od-button-accent" onClick={onBuild} disabled={buildDisabled}>
          {building ? <LoaderCircle className="od-spin" size={15} /> : <Clapperboard size={15} />}
          {building ? "Building cut" : render ? "Generate new video" : "Generate video"}
        </button>
      </header>
      {thumbnailUnavailable && <Notice>{PHONE_VERIFY}</Notice>}
      {edition?.error && <Notice error>{edition.error}</Notice>}
      {render?.url && availability?.reason && (
        <div className="od-upload-block" role="status">YouTube upload unavailable. {availability.reason}</div>
      )}
      {publication?.error && publication.error !== edition?.error && <Notice error>{publication.error}</Notice>}
      {uploadErrors.map((error) => <Notice error key={error}>{error}</Notice>)}
      <Corrections corrections={edition?.corrections} timeZone={settings?.timezone} />
      {edition?.verification?.ok && render && !stale && (
        <Notice>Source review passed for {edition.verification.segments?.length || 0} stories.</Notice>
      )}
      <div className="od-panel od-preview">
        {building && (
          <div className="od-build">
            <div><LoaderCircle className="od-spin" size={16} /><strong>{progress.message || "Rendering the episode"}</strong></div>
            <progress aria-label="Video build progress" value={progress.percent ?? 0} max="100" />
          </div>
        )}
        {render?.url ? (
          <>
            <video key={render.url} preload="metadata" src={render.url} controls aria-label="Episode preview" />
            <div className="od-preview-meta">
              {episodeThumb && <img className="od-thumb" src={episodeThumb} alt={thumbnailLine(edition, "episode") || "Episode thumbnail"} />}
              <div>
                <strong>{render.title}</strong>
                {!!duration && <span>{Math.floor(duration / 60)}:{String(duration % 60).padStart(2, "0")} runtime</span>}
                <ThumbnailNote slot={episodeSlot} />
                {episodeThumb && (
                  <ThumbnailLine initial={thumbnailLine(edition, "episode")} pending={Boolean(pending)}
                    onUpdate={(text) => onRegenerate("episode", text)} onRedraw={() => onRegenerate("episode")} />
                )}
              </div>
              <div className="od-preview-actions">
                <a className="od-button" href={render.url} download><ArrowDownToLine size={15} /> MP4</a>
                <YoutubeButton slot={episodeSlot} pending={pending === "youtube-episode"} disabled={uploadDisabled}
                  blocked={availability?.episode} onClick={() => onUpload("episode")} />
                {waitingUploads > 0 && (
                  <button type="button" className="od-button od-upload-all" disabled={uploadDisabled || Boolean(pending)}
                    title="Uploads the recap first, then every Short, one at a time." onClick={onUploadAll}>
                    {pending === "youtube-all" ? <LoaderCircle className="od-spin" size={14} /> : <SquarePlay size={14} />}
                    {pending === "youtube-all" ? "Starting uploads" : `Upload all (${waitingUploads})`}
                  </button>
                )}
              </div>
            </div>
            {render.shorts?.length > 0 && (
              <ul className="od-shorts" aria-label="Shorts, one per segment">
                {render.shorts.map((short) => {
                  const thumb = thumbnailSrc(edition, short.segment);
                  return (
                    <li key={short.segment}>
                      <span className="od-short-number">{String(short.segment).padStart(2, "0")}</span>
                      {thumb && <img className="od-short-thumb" src={thumb} alt={thumbnailLine(edition, short.segment) || `Short ${short.segment} thumbnail`} />}
                      <span className="od-short-copy">
                        <span className="od-short-title">{short.headline}</span>
                        <ThumbnailNote slot={edition?.youtube?.shorts?.[String(short.segment)]} />
                        {thumb && (
                          <ThumbnailLine initial={thumbnailLine(edition, short.segment)} pending={Boolean(pending)}
                            onUpdate={(text) => onRegenerate(short.segment, text)} onRedraw={() => onRegenerate(short.segment)} />
                        )}
                      </span>
                      <span className="od-short-length">{Math.floor(short.duration / 60)}:{String(Math.round(short.duration) % 60).padStart(2, "0")}</span>
                      <a href={short.url} download><ArrowDownToLine size={14} /> Short</a>
                      <YoutubeButton slot={edition?.youtube?.shorts?.[String(short.segment)]} pending={pending === `youtube-${short.segment}`}
                        disabled={uploadDisabled} blocked={availability?.shorts?.[short.segment]} onClick={() => onUpload(short.segment)} />
                    </li>
                  );
                })}
              </ul>
            )}
            <AnchorScript anchor={render.anchor} />
            <Shots shots={render.shots} />
          </>
        ) : (
          <div className="od-preview-empty">
            {building ? <LoaderCircle className="od-spin" size={27} /> : <Film size={27} strokeWidth={1.5} />}
            <strong>{building ? "Rendering the episode" : "No video yet"}</strong>
            <p>{building ? (progress.message || "The preview will appear when the cut is ready.")
              : edition?.sample ? "Build the practice edition from the included takes."
                : "The overnight build uses the stories included in this rundown."}</p>
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

// The top-level tabs follow the address hash; anything else is the desk.
const tabFor = (hash) => (hash === "#calendar" ? "calendar" : hash === "#comments" ? "comments" : "desk");

export default function SportsApp() {
  const [view, setView] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState(null);
  const [uploadNotices, setUploadNotices] = useState([]);
  const [pending, setPending] = useState("");
  const [editor, setEditor] = useState(null);
  const [target, setTarget] = useState(null);
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState(() => tabFor(window.location.hash));
  const [book, setBook] = useState(null);
  const [calendarMonth, setCalendarMonth] = useState(null);
  const [calendarError, setCalendarError] = useState("");
  const [calendarPending, setCalendarPending] = useState(false);
  const input = useRef(null);
  const mutation = useRef({ version: 0, active: false });
  const seenUploads = useRef({ date: null, slots: new Map() });
  const nextNotice = useRef(0);
  const edition = view?.edition;
  const settings = view?.settings;
  const comments = view?.comments;
  const topics = edition?.topics || [];
  const isActive = inProgress(edition);
  const commentsRunning = comments?.status === "running";
  const locked = edition?.locked ?? ["published", "uploading", "uncertain"].includes(edition?.publication?.status);
  const selectedTopic = topics.find((topic) => topic.id === target);
  const included = topics.filter((topic) => topic.selected).length;
  const claims = ledger?.claims ? Object.fromEntries(ledger.claims.map((claim) => [claim.id, claim])) : null;
  const loadLedger = async (signal) => {
    try {
      const next = await request("/ledger", "GET", undefined, signal);
      if (!signal?.aborted) setLedger({ ...next, claims: publicClaims(next) });
    } catch {}
  };

  useEffect(() => {
    const previous = document.title;
    document.title = "The Rundown · Wellspring Media Sports";
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
        if (next.edition?.topics?.some((topic) => topic.claimIds?.length)) await loadLedger(controller.signal);
      } catch (error) {
        if (version === mutation.current.version && !controller.signal.aborted) setLoadError(error.message);
      } finally {
        loading = false;
      }
    };
    refresh();
    const timer = window.setInterval(refresh, isActive || commentsRunning ? 2500 : 20000);
    const refreshOnVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", refreshOnVisible);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshOnVisible);
    };
  }, [isActive, commentsRunning]);

  // The calendar tab follows the address hash; the desk links scroll once shown.
  useEffect(() => {
    const follow = () => {
      const next = tabFor(window.location.hash);
      setTab(next);
      if (next === "desk" && window.location.hash) {
        window.requestAnimationFrame(() => document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: "start" }));
      }
    };
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);

  // Reminders load on every tab, since their notifications show everywhere.
  const reminderPath = (path) => `${path}${calendarMonth ? `?month=${calendarMonth}` : ""}`;
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        setBook(await request(reminderPath("/reminders"), "GET", undefined, controller.signal));
        setCalendarError("");
      } catch (error) {
        if (!controller.signal.aborted) setCalendarError(error.message);
      }
    };
    load();
    const timer = window.setInterval(load, 60_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [calendarMonth]);

  async function changeReminders(path, method, body) {
    setCalendarPending(true);
    try {
      const next = await request(reminderPath(path), method, body);
      setBook(next);
      setCalendarError("");
      return next;
    } catch (error) {
      setCalendarError(error.message);
      return null;
    } finally {
      setCalendarPending(false);
    }
  }

  function notifyUpload(message, error = false) {
    const id = ++nextNotice.current;
    setUploadNotices((notices) => [...notices.slice(-3), { id, message, error }]);
  }

  useEffect(() => {
    if (!edition) return;
    const seen = seenUploads.current;
    const sameEdition = seen.date === edition.date;
    const slots = new Map();
    for (const [key, label, slot] of youtubeSlots(edition)) {
      if (!slot) continue;
      const { status, lastAttempt, at, error } = slot;
      const signature = JSON.stringify([status, lastAttempt, at, error]);
      slots.set(key, signature);
      if (sameEdition && seen.slots.get(key) === signature) continue;
      if (status === "uploading") notifyUpload(`${label} upload started.`);
      if (!sameEdition) continue;
      if (status === "published") notifyUpload(`${label} upload complete.`);
      if (status === "failed") notifyUpload(`${label} upload failed. ${error || "Try again from the episode panel."}`, true);
      if (status === "uncertain") notifyUpload(`${label} upload could not be confirmed. ${error || "Check YouTube Studio."}`, true);
    }
    seenUploads.current = { date: edition.date, slots };
  }, [edition]);

  const seenComments = useRef(null);
  useEffect(() => {
    if (!comments) return;
    const signature = JSON.stringify([comments.status, comments.at, comments.liked, comments.replied, comments.remaining, comments.failed, comments.error]);
    if (seenComments.current === null) {
      seenComments.current = signature;
      return;
    }
    if (seenComments.current === signature) return;
    seenComments.current = signature;
    const summary = commentSummary(comments);
    if (summary) notifyUpload(summary.message, summary.error);
  }, [comments]);

  async function replyToComments() {
    if (mutation.current.active || commentsRunning) return false;
    mutation.current = { version: mutation.current.version + 1, active: true };
    setPending("comments");
    setActionError(null);
    try {
      const next = await request("/comments", "POST", {});
      setView(next.edition ? next : await request("/edition"));
      setLoadError("");
      return true;
    } catch (error) {
      setActionError({ action: "comments", message: error.message });
      return false;
    } finally {
      mutation.current.active = false;
      setPending("");
    }
  }

  async function regenerateThumbnails(target, text) {
    if (mutation.current.active) return false;
    mutation.current = { version: mutation.current.version + 1, active: true };
    setPending(`thumb-${target}`);
    setActionError(null);
    try {
      const next = await request("/thumbnails", "POST", {
        target, date: edition?.date, ...(text != null && String(text).trim() ? { text } : {}),
      });
      setView(next.edition ? next : await request("/edition"));
      setLoadError("");
      return true;
    } catch (error) {
      setActionError({ action: "thumbnail", message: error.message });
      return false;
    } finally {
      mutation.current.active = false;
      setPending("");
    }
  }

  async function uploadAll() {
    if (mutation.current.active) return false;
    mutation.current = { version: mutation.current.version + 1, active: true };
    setPending("youtube-all");
    setActionError(null);
    try {
      const next = await request("/youtube/all", "POST", { date: edition?.date });
      setView(next.edition ? next : await request("/edition"));
      setLoadError("");
      return true;
    } catch (error) {
      notifyUpload(`Upload all failed. ${error.message}`, true);
      return false;
    } finally {
      mutation.current.active = false;
      setPending("");
    }
  }

  async function uploadVideo(target) {
    if (mutation.current.active) return false;
    mutation.current = { version: mutation.current.version + 1, active: true };
    setPending(`youtube-${target}`);
    setActionError(null);
    try {
      const next = await request("/youtube", "POST", { target, date: edition?.date });
      setView(next.edition ? next : await request("/edition"));
      setLoadError("");
      return true;
    } catch (error) {
      notifyUpload(`${target === "episode" ? "Recap" : `Short ${target}`} upload failed. ${error.message}`, true);
      return false;
    } finally {
      mutation.current.active = false;
      setPending("");
    }
  }

  async function mutate(path, method, payload, action) {
    if (mutation.current.active || (locked && !(edition?.publication?.status === "published" && ["revision", "research", "build"].includes(action)))) return false;
    mutation.current = { version: mutation.current.version + 1, active: true };
    setPending(action);
    setActionError(null);
    try {
      const next = await request(path, method, { ...payload, date: edition?.date });
      const updated = next.edition ? next : await request("/edition");
      setView(updated);
      setLoadError("");
      if (["scan", "correct", "resolve", "trend", "build"].includes(action)) await loadLedger();
      return updated;
    } catch (error) {
      setActionError({ action, message: error.message });
      return false;
    } finally {
      mutation.current.active = false;
      setPending("");
    }
  }

  async function addStory(category) {
    if (locked && !await mutate("/revision", "POST", {}, "revision")) return;
    setEditor(category === "other" ? "new-other" : "new");
  }

  function discuss(topic) {
    setTarget(topic.id);
    document.getElementById("od-chat")?.scrollIntoView({ block: "nearest" });
    input.current?.focus({ preventScroll: true });
  }

  return (
    <div className="od">
      {(uploadNotices.length > 0 || book?.due?.length > 0) && <aside className="od-upload-notifications" aria-label="Notifications">
        {(book?.due || []).map((due) => <div key={`${due.id}-${due.occurrence}-${due.stage}`} className={`od-reminder-notice is-${due.stage}`}>
          <div className="od-notice" role="status">
            <BellRing size={16} />
            <span><strong>{dueLabel(due)}</strong> · {due.title}{due.notes && <small>{due.notes}</small>}</span>
          </div>
          <button type="button" className="od-notification-close" aria-label={`Dismiss the reminder for ${due.title}`} disabled={calendarPending}
            onClick={() => changeReminders(`/reminders/${encodeURIComponent(due.id)}/dismiss`, "POST", { occurrence: due.occurrence, stage: due.stage })}><X size={16} /></button>
        </div>)}
        {uploadNotices.map(({ id, message, error }) => <div key={id}>
          <Notice error={error}>{message}</Notice>
          <button type="button" className="od-notification-close" aria-label="Dismiss notification"
            onClick={() => setUploadNotices((notices) => notices.filter((entry) => entry.id !== id))}><X size={16} /></button>
        </div>)}
      </aside>}
      <header className="od-topbar">
        <div className="od-topbar-inner">
          <a className="od-brand" href="/sports" aria-label="Wellspring Media Sports home">
            <img className="od-brand-icon" src={wellspringLogo} alt="" />
            <span>WELLSPRING<span className="od-brand-desk"> MEDIA</span></span>
          </a>
          <nav aria-label="Desk navigation">
            <a href="#od-rundown" aria-current={tab === "desk" ? "page" : undefined}>Rundown</a><a href="#od-chat">Chat</a><a href="#od-episode">Episode</a>
            <a href="#comments" className="od-nav-calendar" aria-current={tab === "comments" ? "page" : undefined}><MessageSquare size={15} /> Comments</a>
            <a href="#calendar" className="od-nav-calendar" aria-current={tab === "calendar" ? "page" : undefined}>
              <CalendarDays size={15} /> Calendar{book?.due?.length > 0 && <span className="od-nav-count" aria-label={`${book.due.length} due`}>{book.due.length}</span>}
            </a>
          </nav>
          <div className="od-top-actions">
            <EmergencyFix />
            <ListenWithRoger />
            <button type="button" className="od-button od-button-accent od-top-comments" aria-label="Reply to YouTube comments"
              disabled={!view || pending === "comments" || commentsRunning || !settings?.youtubeConfigured || !settings?.researchConfigured}
              title={commentTitle(settings, comments)} onClick={replyToComments}>
              {commentsRunning || pending === "comments" ? <LoaderCircle className="od-spin" size={14} /> : <ThumbsUp size={14} />}
              <span className="od-top-comments-label">{commentsRunning ? "Checking comments" : "Reply to comments"}</span>
            </button>
            <div className="od-editor-badge"><span aria-hidden="true">I</span> Isaac Doss</div>
          </div>
        </div>
      </header>
      <main className="od-workspace">
        {tab === "comments" ? <CommentsTab request={request} /> : tab === "calendar" ? (
          <CalendarTab book={book} error={calendarError} pending={calendarPending} onMonth={setCalendarMonth}
            onSave={(id, fields) => changeReminders(id ? `/reminders/${encodeURIComponent(id)}` : "/reminders", id ? "PATCH" : "POST", fields)}
            onDelete={(id) => changeReminders(`/reminders/${encodeURIComponent(id)}`, "DELETE")} />
        ) : <>
        <EditionHeader edition={edition} settings={settings} />
        {loadError && <Notice error>{loadError}</Notice>}
        {actionError && actionError.action !== "chat" && <Notice error>{actionError.message}</Notice>}
        {edition?.generationRetry && isActive && <Notice>Generation is retrying automatically (retry {edition.generationRetry.attempt}). Completed stories are saved.</Notice>}
        {comments && (comments.status === "failed" || (comments.status === "done" && (comments.remaining > 0 || comments.likesUnsupported || comments.failed > 0))) && (
          <Notice error={comments.status === "failed" || comments.failed > 0}>{commentSummary(comments).message}{comments.likesUnsupported && <> <a href="https://studio.youtube.com/" target="_blank" rel="noreferrer">Open YouTube Studio</a></>}</Notice>
        )}
        {view && !settings?.researchConfigured && (
          <Notice>{edition?.sample ? "Practice edition. " : ""}Connect a research model to run the live overnight workflow.</Notice>
        )}
        <div className="od-work-grid">
          <section id="od-rundown" className="od-rundown" aria-labelledby="od-rundown-title">
            <header className="od-section-heading">
              <div>
                <h2 id="od-rundown-title">Story lineup</h2>
                <p>{topics.length > 0 ? `${included} of ${topics.length} stories selected · aim for ${PREFERRED_SHORTS_COUNT} Shorts from ${DAILY_STORY_TARGET} candidates` : `Daily shortlist: ${DAILY_STORY_TARGET} candidates · keep your best ${PREFERRED_SHORTS_COUNT}`}{settings?.scope?.label ? ` · covering ${settings.scope.label}` : ""}</p>
              </div>
              <div className="od-section-actions">
                {["researching", "building"].includes(edition?.status) && <button type="button" className="od-button" disabled={Boolean(pending)}
                  onClick={() => mutate("/cancel", "POST", {}, "cancel")}><X size={15} /> Stop generation</button>}
                {settings?.evidenceProvider && (
                  <button type="button" className="od-button" disabled={Boolean(pending) || isActive || locked} title={`Scan tonight's slate through the ${settings.evidenceProvider} evidence adapter`}
                    onClick={() => mutate("/evidence/scan", "POST", {}, "scan")}>
                    <ScanSearch size={14} className={pending === "scan" ? "od-spin" : ""} /> Scan slate
                  </button>
                )}
                  <button type="button" className="od-button" disabled={Boolean(pending) || isActive || !settings?.researchConfigured || (locked && edition?.publication?.status !== "published")}
                    onClick={() => mutate("/research", "POST", {}, "research")}>
                    <RefreshCw size={14} className={edition?.status === "researching" ? "od-spin" : ""} />
                    {edition?.status === "researching" ? "Researching" : "Do research"}
                  </button>
                <button type="button" className="od-button" disabled={!view || Boolean(pending) || isActive || (locked && edition?.publication?.status !== "published")}
                  onClick={() => addStory()}><Plus size={16} /> Add story</button>
                <button type="button" className="od-button od-button-accent" disabled={!view || Boolean(pending) || isActive || (locked && edition?.publication?.status !== "published")}
                  onClick={() => addStory("other")}><Plus size={16} /> Add other news</button>
                <button type="button" className="od-button" disabled={!view || Boolean(pending) || isActive || !included || (locked && edition?.publication?.status !== "published")}
                  onClick={() => mutate("/build", "POST", {}, "build")}><Clapperboard size={15} /> Generate video</button>
              </div>
            </header>
            {locked && edition?.publication?.status === "published" && <Notice>This edition was published. Research, add a story, or generate an updated video to start a new draft. The published video stays available.</Notice>}
            {edition?.manualRevision && <Notice>This is an editable update. It will only upload to YouTube when you choose to upload it.</Notice>}
            {(edition?.releases || []).map((release) => release.publication?.url && <p key={`${release.revision}-${release.at}`}><a href={externalUrl(release.publication.url)} target="_blank" rel="noreferrer">View the previously published episode</a></p>)}
            {["new", "new-other"].includes(editor) && !locked && (
              <div className="od-panel od-new-topic">
                <h3>{editor === "new-other" ? "Add other news" : "Add a story"}</h3>
                {included >= MAX_EPISODE_STORIES && <p className="od-form-hint">Twenty stories are already included. This story will be saved outside the episode until you exclude another story and include it.</p>}
                <TopicForm key={editor} category={editor === "new-other" ? "other" : undefined} scope={settings?.scope} modelConfigured={settings?.researchConfigured} pending={Boolean(pending)} onClose={() => setEditor(null)}
                  onSave={async (fields) => {
                    const saved = await mutate("/topics", "POST", fields, "topic");
                    if (saved && fields.take) setEditor(saved.edition.topics.at(-1).id);
                    return saved;
                  }} />
              </div>
            )}
            <Slate slate={edition?.slate} lastScan={edition?.lastScan} timeZone={settings?.timezone} />
            <TrendDesk trendDesk={edition?.trendDesk} topics={topics} timeZone={settings?.timezone} />
            {topics.length === 0 && (
              <div className="od-panel od-empty">
                {(!view && !loadError) || edition?.status === "researching" ? <LoaderCircle className="od-spin" size={20} /> : <Clock3 size={19} />}
                {edition?.status === "researching" ? "Researching the top stories…" : view ? "No topics have been filed for this edition." : loadError ? "The lineup is unavailable." : "Loading the lineup…"}
              </div>
            )}
            <div className="od-topic-list">
              {topics.map((topic) => (
                <TopicCard key={topic.id} topic={topic} claims={claims} scope={settings?.scope} modelConfigured={settings?.researchConfigured} editing={editor === topic.id}
                  pending={Boolean(pending)} locked={locked} isCore={edition.trendDesk?.coreTopicId === topic.id}
                  onEdit={() => setEditor(topic.id)} onClose={() => setEditor(null)}
                  onSave={(fields) => mutate(`/topics/${encodeURIComponent(topic.id)}`, "PATCH", fields, "topic")}
                  onChat={() => discuss(topic)}
                  onTrend={() => mutate(`/topics/${encodeURIComponent(topic.id)}/trend`, "POST", {}, "trend")}
                  onCore={() => mutate("/trend/core", "POST", { topicId: edition.trendDesk?.coreTopicId === topic.id ? null : topic.id }, "core")}
                  onCorrect={(claimId, fields) => mutate(`/claims/${encodeURIComponent(claimId)}/correct`, "POST", fields, "correct")}
                  onResolve={(claimId, fields) => mutate(`/claims/${encodeURIComponent(claimId)}/resolve`, "POST", fields, "resolve")}
                  onClip={(clipId, fields) => mutate(`/topics/${encodeURIComponent(topic.id)}/clips/${encodeURIComponent(clipId)}`, "POST", fields, "clip")} />
              ))}
            </div>
          </section>
          <Chat edition={edition} settings={settings} topic={selectedTopic} clearTopic={() => setTarget(null)}
            draft={draft} setDraft={setDraft} input={input} pending={pending === "chat" || !view} locked={locked}
            error={actionError?.action === "chat" ? actionError.message : ""} onDiscuss={discuss}
            onSend={(message) => mutate("/chat", "POST", { message, ...(selectedTopic && { topicId: selectedTopic.id }) }, "chat")} />
          <Episode edition={edition} settings={settings} pending={pending} locked={locked}
            onBuild={() => mutate("/build", "POST", {}, "build")}
            onUpload={(target) => uploadVideo(target)}
            onUploadAll={() => uploadAll()}
            onRegenerate={(target, text) => regenerateThumbnails(target, text)} />
        </div>
        </>}
      </main>
    </div>
  );
}
