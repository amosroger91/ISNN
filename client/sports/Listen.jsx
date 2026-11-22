import { useEffect, useRef, useState } from "react";
import { Headphones, LoaderCircle, Square } from "lucide-react";

// "Listen with Roger": shown only while Spotify is open on the desk PC.
// Playing streams that app's audio here; stopping closes the stream.
export function ListenWithRoger() {
  const [status, setStatus] = useState(null);
  const [state, setState] = useState("idle"); // idle | connecting | playing
  const [error, setError] = useState("");
  const audio = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const response = await fetch("/api/sports/listen");
        const next = response.ok ? await response.json() : null;
        if (!cancelled) setStatus(next);
      } catch {
        if (!cancelled) setStatus(null);
      }
    };
    check();
    const timer = window.setInterval(check, 15_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  const stop = () => {
    const player = audio.current;
    if (player) {
      player.pause();
      player.removeAttribute("src");
      player.load();
    }
    setState("idle");
  };

  // Spotify closed while listening: drop the player too.
  useEffect(() => {
    if (!status?.active && state !== "idle") stop();
  }, [status?.active]);

  if (!status?.active) return null;

  const start = async () => {
    setError("");
    setState("connecting");
    const player = audio.current;
    // A fresh URL each time, so the browser never replays a cached stream.
    player.src = `/api/sports/listen/stream?at=${Date.now()}`;
    try {
      await player.play();
    } catch (failure) {
      setError(failure?.message || "The stream could not start.");
      stop();
    }
  };

  const label = state === "playing" ? (status.title || "Spotify is paused") : "Listen with Roger";
  return (
    <div className={`od-listen${state !== "idle" ? " is-on" : ""}`}>
      <audio ref={audio} preload="none" onPlaying={() => setState("playing")}
        onError={() => { if (state !== "idle") { setError("The stream stopped."); stop(); } }} />
      {state === "idle" ? (
        <button type="button" className="od-button od-listen-button" onClick={start}
          title={status.title ? `Roger is playing ${status.title}` : "Hear what Roger is playing on Spotify"}>
          <Headphones size={14} /> <span className="od-listen-label">Listen with Roger</span>
        </button>
      ) : (
        <button type="button" className="od-button od-listen-button" onClick={stop} aria-label="Stop listening" title={error || "Stop listening"}>
          {state === "connecting" ? <LoaderCircle className="od-spin" size={14} /> : <Square size={12} fill="currentColor" />}
          <span className="od-listen-label">{state === "connecting" ? "Connecting…" : label}</span>
        </button>
      )}
      {error && state === "idle" && <span className="od-listen-error" role="alert">{error}</span>}
    </div>
  );
}
