import { useEffect, useState } from "react";
import { ArrowUpRight, CornerDownRight, LoaderCircle, MessageSquare, RefreshCw, ThumbsUp } from "lucide-react";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "unanswered", label: "Needs a reply" },
  { id: "answered", label: "Replied" },
];

function when(stamp) {
  if (!stamp) return "";
  const time = Date.parse(stamp);
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(time));
}

const commentLink = (videoId, commentId) => `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&lc=${encodeURIComponent(commentId)}`;

function Comment({ comment, reply = false }) {
  return (
    <div className={`od-comment${reply ? " is-reply" : ""}${comment.mine ? " is-mine" : ""}`}>
      <span className="od-comment-avatar" aria-hidden="true">{(comment.author.replace(/^@/u, "")[0] || "?").toUpperCase()}</span>
      <div className="od-comment-body">
        <div className="od-comment-meta">
          <strong>{comment.author}</strong>
          {comment.mine && <span className="od-comment-badge">Channel</span>}
          {comment.held && <span className="od-comment-badge is-held">Held for review</span>}
          <span>{when(comment.publishedAt)}</span>
          {comment.likes > 0 && <span className="od-comment-likes"><ThumbsUp size={12} /> {comment.likes}</span>}
        </div>
        <p>{comment.text}</p>
      </div>
    </div>
  );
}

export function CommentsTab({ request }) {
  const [feed, setFeed] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("all");

  const load = async (refresh = false) => {
    setLoading(true);
    try {
      setFeed(await request(`/comments/threads${refresh ? "?refresh=1" : ""}`));
      setError("");
    } catch (failure) {
      setError(failure.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const threads = (feed?.threads || []).filter((thread) => filter === "all" || (filter === "answered" ? thread.answered : !thread.answered && !thread.held));
  const byVideo = [];
  for (const thread of threads) {
    const group = byVideo.at(-1);
    if (group && group.videoId === thread.videoId) group.threads.push(thread);
    else byVideo.push({ videoId: thread.videoId, title: thread.videoTitle, threads: [thread] });
  }

  return (
    <section className="od-comments" aria-labelledby="od-comments-title">
      <header className="od-section-heading">
        <div>
          <h2 id="od-comments-title">Comments</h2>
          <p>{feed ? `${feed.total} comment${feed.total === 1 ? "" : "s"} on the channel · ${feed.unanswered} without a reply · updated ${when(feed.at)}` : "Viewer comments and the channel’s replies"}</p>
        </div>
        <div className="od-section-actions">
          <div className="od-kind-switch" role="radiogroup" aria-label="Filter comments">
            {FILTERS.map(({ id, label }) => (
              <button key={id} type="button" role="radio" aria-checked={filter === id} className={filter === id ? "is-active" : ""} onClick={() => setFilter(id)}>{label}</button>
            ))}
          </div>
          <button type="button" className="od-button" disabled={loading} onClick={() => load(true)}>
            <RefreshCw size={14} className={loading ? "od-spin" : ""} /> Refresh
          </button>
        </div>
      </header>
      {error && <div className="od-notice is-error" role="alert"><span>{error}</span></div>}
      {!feed && !error && <div className="od-panel od-empty"><LoaderCircle className="od-spin" size={20} /> Loading comments from YouTube…</div>}
      {feed && threads.length === 0 && (
        <div className="od-panel od-empty"><MessageSquare size={19} /> {filter === "unanswered" ? "Every comment has a reply." : "No comments yet."}</div>
      )}
      <div className="od-comment-videos">
        {byVideo.map((group, index) => (
          <article key={`${group.videoId}-${index}`} className="od-panel od-comment-video">
            <header>
              <h3>{group.title || "Untitled video"}</h3>
              {group.videoId && <a className="od-button od-button-quiet" href={`https://www.youtube.com/watch?v=${encodeURIComponent(group.videoId)}`} target="_blank" rel="noreferrer">Video <ArrowUpRight size={13} /></a>}
            </header>
            <ul>
              {group.threads.map((thread) => (
                <li key={thread.id} className={`od-comment-thread${thread.answered ? "" : " is-open"}`}>
                  <Comment comment={thread} />
                  {thread.replies.length > 0 && <div className="od-comment-replies">
                    {thread.replies.map((reply) => <div key={reply.id} className="od-comment-reply-row"><CornerDownRight size={14} aria-hidden="true" /><Comment comment={reply} reply /></div>)}
                  </div>}
                  <div className="od-comment-actions">
                    {!thread.answered && !thread.held && <span className="od-comment-badge is-open">Needs a reply</span>}
                    {thread.videoId && <a href={commentLink(thread.videoId, thread.id)} target="_blank" rel="noreferrer">Open on YouTube <ArrowUpRight size={12} /></a>}
                  </div>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}
