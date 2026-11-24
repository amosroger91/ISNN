// Reconnect YouTube from a phone: when Google revokes or expires the saved
// refresh token (invalid_grant), the owner signs in again through the desk and
// the new token is written to .env and used at once, without a restart.
import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
// The OAuth Playground is a redirect URI the channel's OAuth client already
// accepts. Set YOUTUBE_REDIRECT_URI to the desk's own callback once it is
// registered in Google Cloud, and the sign-in completes by itself.
export const PLAYGROUND_REDIRECT = "https://developers.google.com/oauthplayground";
// youtube.force-ssl also covers comment replies; youtube.upload covers uploads.
export const SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.force-ssl"];
const STATE_LIFETIME = 15 * 60_000;

export function redirectUri() {
  return process.env.YOUTUBE_REDIRECT_URI?.trim() || PLAYGROUND_REDIRECT;
}

export class YoutubeReconnect {
  constructor({ envFile, stateFile, fetchImpl = fetch, now = () => Date.now() } = {}) {
    this.envFile = envFile;
    // The pending sign-in survives a desk restart in the middle of it.
    this.stateFile = stateFile;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.pending = [];
  }

  async loadPending() {
    if (!this.pending.length && this.stateFile) {
      const saved = JSON.parse(await readFile(this.stateFile, "utf8").catch(() => "[]"));
      this.pending = Array.isArray(saved) ? saved : [saved].filter(Boolean);
    }
    this.pending = this.pending.filter((entry) => entry.expires >= this.now());
  }

  async savePending() {
    if (!this.stateFile) return;
    if (this.pending.length) await writeFile(this.stateFile, JSON.stringify(this.pending), { mode: 0o600 });
    else await rm(this.stateFile, { force: true });
  }

  async start() {
    const state = randomBytes(16).toString("hex");
    await this.loadPending();
    const entry = { state, redirect: redirectUri(), expires: this.now() + STATE_LIFETIME };
    this.pending = [...this.pending, entry].slice(-5);
    await this.savePending();
    return `${AUTH_URL}?${new URLSearchParams({
      client_id: process.env.YOUTUBE_CLIENT_ID.trim(), redirect_uri: entry.redirect, response_type: "code",
      scope: SCOPES.join(" "), access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
    })}`;
  }

  // Accepts the address Google sent the browser to, or a bare code.
  async complete(input, stateFromCallback) {
    const text = String(input || "").trim();
    let code = text;
    let state = stateFromCallback;
    const url = URL.parse(text);
    if (url) {
      const error = url.searchParams.get("error");
      if (error) throw new Error(`Google did not grant access (${error.replace(/[^\w.-]/g, "").slice(0, 60)}).`);
      code = url.searchParams.get("code") || "";
      state = url.searchParams.get("state") ?? state;
    }
    if (!/^[\w./-]{10,512}$/.test(code)) throw new Error("That address has no Google sign-in code. Copy the whole address after tapping Allow.");
    await this.loadPending();
    if (!this.pending.length) throw new Error("This sign-in expired. Start it again.");
    const given = state !== undefined && state !== null;
    const pending = given ? this.pending.find((entry) => entry.state === state) : this.pending.at(-1);
    if (!pending) throw new Error("This sign-in does not match the one the desk started. Start it again.");
    const response = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      body: new URLSearchParams({
        code, client_id: process.env.YOUTUBE_CLIENT_ID.trim(), client_secret: process.env.YOUTUBE_CLIENT_SECRET.trim(),
        redirect_uri: pending.redirect, grant_type: "authorization_code",
      }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const reason = typeof body.error === "string" && /^[a-z_]{1,60}$/.test(body.error) ? `, ${body.error}` : "";
      throw new Error(`Google refused the sign-in code (HTTP ${response.status}${reason}). Start it again.`);
    }
    if (!body.refresh_token) throw new Error("Google sent no refresh token. Start again and tap Allow on every screen.");
    this.pending = [];
    await this.savePending();
    await saveEnvValue(this.envFile, "YOUTUBE_REFRESH_TOKEN", body.refresh_token);
    process.env.YOUTUBE_REFRESH_TOKEN = body.refresh_token;
    return { scope: body.scope || "" };
  }
}

export async function saveEnvValue(file, key, value) {
  if (!/^[\w./~+-]+$/.test(value)) throw new Error(`Refusing to write an unexpected ${key} value.`);
  const text = await readFile(file, "utf8").catch((error) => (error.code === "ENOENT" ? "" : Promise.reject(error)));
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  const next = pattern.test(text) ? text.replace(pattern, () => line) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, next, { mode: 0o600 });
  await rename(temporary, file);
}

export function reconnectPage({ message = "", error = "", playground = true } = {}) {
  const escape = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const steps = playground
    ? `<ol><li>Tap <b>Sign in with Google</b> and choose the channel account. Tap <b>Allow</b> on every screen.</li>
<li>You land on the Google OAuth Playground. Don't press anything there. Copy the <b>whole address</b> from the address bar.</li>
<li>Come back here, paste it below and tap <b>Reconnect</b>.</li></ol>`
    : `<p>Tap <b>Sign in with Google</b>, choose the channel account and tap <b>Allow</b>. The desk finishes by itself.</p>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reconnect YouTube</title><style>body{font:17px system-ui,sans-serif;max-width:34rem;margin:1.5rem auto;padding:0 1rem}
a.b,button{display:block;width:100%;padding:.9rem;margin:.8rem 0;font-size:1.05rem;border-radius:.6rem;border:0;background:#c00;color:#fff;text-align:center;text-decoration:none}
textarea{width:100%;min-height:6rem;font-size:1rem;box-sizing:border-box}.ok{color:#070}.err{color:#b00}</style></head><body>
<h1>Reconnect YouTube</h1>
${message ? `<p class="ok">${escape(message)}</p>` : ""}${error ? `<p class="err">${escape(error)}</p>` : ""}
${steps}
<a class="b" href="/api/sports/youtube/reconnect/start">Sign in with Google</a>
${playground ? `<form method="get" action="/api/sports/youtube/reconnect/complete"><textarea name="address" placeholder="https://developers.google.com/oauthplayground/?state=…&amp;code=…" required></textarea><button>Reconnect</button></form>` : ""}
</body></html>`;
}
