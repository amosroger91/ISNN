import { z } from "zod";
import { MAX_EPISODE_STORIES } from "../../shared/sports-limits.mjs";
import { commonsFileTitle } from "./footage.mjs";
import { youtubeVideoId } from "./youtube-footage.mjs";

const webUrl = z.string().trim().max(1200).refine((value) => {
  const url = URL.parse(value);
  return url && ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
}, "Use an HTTP or HTTPS source link without credentials.");

const editFields = z.object({
  id: z.string().regex(/^[\w-]{1,60}$/u).optional(),
  title: z.string().trim().min(3).max(160).optional(),
  summary: z.string().trim().max(1200).optional(),
  take: z.string().trim().max(1800).optional(),
  takeScript: z.string().trim().max(1200).optional(),
  headline: z.string().trim().min(3).max(140).optional(),
  narration: z.string().trim().min(20).max(1800).optional(),
  selected: z.boolean().optional(),
  sport: z.enum(["basketball", "football", "baseball", "hockey", "soccer", "mma", "other"]).nullable().optional(),
  league: z.string().trim().min(2).max(40).nullable().optional(),
  teams: z.array(z.string().trim().min(2).max(60)).max(6).optional(),
  url: webUrl.optional(),
  excerpt: z.string().trim().max(1000).optional(),
  clipUrl: z.string().trim().max(1200).refine((value) => !value || commonsFileTitle(value) || youtubeVideoId(value),
    "Use a YouTube video link or Wikimedia Commons File page.").optional(),
});

export const editorialEdits = z.array(z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  // Local JSON models commonly spell an omitted field as null or an empty ID.
  // This is absence, not an instruction to erase an existing story field.
  return Object.fromEntries(Object.entries(value).filter(([key, item]) =>
    (item !== null || ["sport", "league"].includes(key))
    && !(item === "" && ["id", "title", "headline", "narration", "url"].includes(key))));
}, editFields)).max(MAX_EPISODE_STORIES).superRefine((edits, ctx) => {
  const ids = new Set();
  edits.forEach((edit, index) => {
    if (!edit.id && !edit.title) ctx.addIssue({ code: "custom", message: "A new topic needs a title.", path: [index] });
    if (edit.id && ids.has(edit.id)) ctx.addIssue({ code: "custom", message: "Edit each topic once per message.", path: [index] });
    if (edit.id) ids.add(edit.id);
    if (edit.excerpt !== undefined && !edit.url) ctx.addIssue({ code: "custom", message: "A source excerpt needs its URL.", path: [index] });
  });
});

export const editorialResponse = z.object({ reply: z.string().trim().min(1).max(2400), edits: editorialEdits });

export function normalizeEditorialPlan(edits, text, messages = [], focusedTopicId) {
  const confirmation = /^(?:yes|yep|yeah|correct|do it|go ahead|please do)[.!\s]*$/iu.test(text.trim());
  const instruction = (confirmation
    ? [...messages].reverse().find(({ role }) => role === "user")?.content || text : text).replace(/https?:\/\/\S+/gu, "");
  const addPhrase = /^(?:(?:can|could|would) you\s+|please\s+|i (?:want|need) (?:you )?to\s+)?(?:add|create)\b[^.!?\n]{0,100}?\b(?:story|topic|segment)\b/iu.exec(instruction)?.[0];
  const adding = Boolean(addPhrase) && !/\b(?:to|for|onto|into|this|that|existing|selected|current)\b/iu.test(addPhrase.split(/\b(?:add|create)\b/iu).at(-1));
  const takeRequested = /\b(?:take|opinion)\b|\beditorial (?:notes|view|comment|angle)\b/iu.test(instruction)
    && !/\bleave\b[^.!?\n]*\b(?:take|opinion|editorial)\b[^.!?\n]*\b(?:alone|unchanged|intact)\b/iu.test(instruction);
  const generalStoryEdit = !takeRequested && /\b(?:edit|update|revise|amend|expand|shorten|tighten|context)\b[^.!?\n]{0,50}\b(?:story|topic|segment)\b|\bmake (?:this |the )?(?:story|topic|segment)\b/iu.test(instruction);
  const scriptRequested = generalStoryEdit || /\b(?:narration|script|on.air|broadcast copy|rewrite)\b/iu.test(instruction);
  const exact = {};
  for (const [field, name] of Object.entries({ title: "title(?:d)?", summary: "summary", take: "(?:editorial )?take(?: notes)?", takeScript: "(?:on.air )?take script", headline: "on.air headline", narration: "narration" })) {
    const match = new RegExp(`\\b${name}\\s+(?:exactly\\s+)?(?:to\\s+|as\\s+)?["“]([^"”]+)["”]`, "iu").exec(instruction);
    if (match) exact[field] = match[1];
  }
  const candidates = !adding && focusedTopicId && Object.keys(exact).length
    ? [{ ...(edits.find(({ id }) => id === focusedTopicId) || {}), id: focusedTopicId }]
    : edits;
  return candidates.map((original) => {
    const edit = { ...original };
    // Small local models sometimes copy a context ID into an add action. An
    // explicit new-story request must never overwrite a story already present.
    if (adding) delete edit.id;
    else {
      if (!generalStoryEdit && !/\b(?:title|headline|rename|call it|named)\b/iu.test(instruction)) delete edit.title;
      if (!generalStoryEdit && !/\b(?:summary|reporting notes|story notes|story text|story details|story body|rewrite|update the notes)\b/iu.test(instruction)) delete edit.summary;
      if (!/\b(?:category|league|sport|teams|other news|non.sports)\b/iu.test(instruction)
        || /\bleave\b[^.!?\n]*\b(?:category|league|sport|teams)\b[^.!?\n]*\b(?:alone|unchanged|intact)\b/iu.test(instruction)) {
        delete edit.league; delete edit.sport; delete edit.teams;
      }
      if (!/\b(?:include|exclude|remove|drop|bench|select|deselect)\b/iu.test(instruction)) delete edit.selected;
      if (!/\b(?:source|article|attach|evidence|link)\b/iu.test(instruction)
        || /\bleave\b[^.!?\n]*\bsource\b[^.!?\n]*\b(?:alone|unchanged|intact)\b/iu.test(instruction)) { delete edit.url; delete edit.excerpt; }
    }
    if (!takeRequested) { delete edit.take; delete edit.takeScript; }
    if (!scriptRequested) { delete edit.narration; delete edit.takeScript; }
    if (!/\bheadline\b/iu.test(instruction)) delete edit.headline;
    if (!/\b(?:footage|clip|b.roll|youtube|video link)\b/iu.test(instruction)) delete edit.clipUrl;
    if (typeof edit.excerpt === "string" && /^["“][\s\S]*["”]$/u.test(edit.excerpt)) edit.excerpt = edit.excerpt.slice(1, -1).trim();
    // Dictated text is an instruction, not something for the model to paraphrase
    // or accidentally replace with a previous turn's edit.
    Object.assign(edit, exact);
    return edit;
  }).filter((edit) => !edit.id || Object.keys(edit).some((key) => key !== "id"));
}

export function questionOnly(text) {
  const question = /^(?:what|why|when|where|who|how|which|is|are|does|do|did|has|have|can i|can we|could i|could we)\b/iu.test(text.trim());
  const extraRequest = /(?:[.!?;]|\b(?:and|also|then))\s*(?:can you |could you |please )?(?:add|edit|change|include|exclude|remove|save|update|rename|rewrite|attach|set|clear)\b/iu.test(text);
  return question && !extraRequest;
}

export function editorialContext(edition, text, focusedTopicId) {
  const words = new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
  const ranked = edition.topics.map((topic, index) => ({ topic, index, score:
    (topic.id === focusedTopicId ? 1000 : 0) + (topic.title.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter((word) => words.has(word)).length,
  })).sort((a, b) => b.score - a.score || a.index - b.index);
  const detailed = new Set(ranked.slice(0, 3).map(({ topic }) => topic.id));
  const context = {
    date: edition.date, focusedTopicId: focusedTopicId || null, editorMessage: text,
    desk: edition.editorialState || { status: edition.status, error: edition.error || null },
    readOnly: Boolean(edition.editorialState?.locked) || questionOnly(text),
    recentConversation: (edition.messages || []).slice(-6).map(({ role, content }) => ({
      speaker: role === "user" ? "Isaac" : "Assistant", text: content.slice(0, 1000),
    })),
    topics: edition.topics.map((topic) => ({
      id: topic.id, title: topic.title, selected: topic.selected, league: topic.league, sport: topic.sport,
      summary: topic.summary?.slice(0, detailed.has(topic.id) ? 1200 : 180),
      take: topic.take?.slice(0, detailed.has(topic.id) ? 1800 : 180),
      ...(detailed.has(topic.id) && {
        teams: topic.teams, takeScript: topic.takeScript, takeError: topic.takeError, skipReason: topic.skipReason,
        script: topic.script && { headline: topic.script.headline, narration: topic.script.narration },
        coverage: topic.coverage, coverageReason: topic.coverageReason, clipUrl: topic.clipUrl,
        sources: (topic.sources || []).slice(0, 4).map(({ title, publisher, url, excerpt, publishedAt }) => ({
          title, publisher, url, excerpt: excerpt?.slice(0, 1400), publishedAt,
        })),
      }),
    })),
  };
  // Keep the local model's context bounded as the rundown grows. Retain every
  // story's ID/title/category and prioritize details from the focused story.
  for (const { topic } of [...ranked].reverse()) {
    if (JSON.stringify(context).length <= 24000) break;
    const row = context.topics.find(({ id }) => id === topic.id);
    if (topic.id !== focusedTopicId) {
      for (const key of ["summary", "take", "takeScript", "script", "sources"]) delete row[key];
    }
  }
  return context;
}

export function directEditorialAnswer(edition, content) {
  const text = content.trim().replace(/[?!.]+$/u, "").toLowerCase().replace(/[’]/gu, "'");
  const state = edition.editorialState || {};
  if (/^(?:help|what can you do|how do i use (?:this |the )?(?:chat|editorial chat))$/u.test(text)) {
    return "Ask about generation progress, errors, the lineup, story details, or source evidence. You can add sports or Other news stories, rename them, edit reporting notes or narration, save your editorial take, attach a source or footage link, and include or exclude stories. Name the story or select Discuss. I save edits to the rundown and show exactly what changed.";
  }
  if (/^(?:status|progress|what(?:'s| is) (?:the )?(?:status|progress)|what(?:'s| is) (?:going on|happening)(?: right now| with (?:the )?(?:app|desk|video|generation|build))?|how(?:'s| is) (?:the )?(?:video|generation|build)(?: going)?|is (?:the )?(?:video|generation|build) (?:done|ready|running|stuck)|why (?:is|did) (?:the )?(?:video|generation|build) (?:stuck|stop|stopped|fail|failed)|which model (?:are we|is (?:the )?(?:app|desk)) using)$/u.test(text)) {
    const selected = edition.topics.filter(({ selected }) => selected).length;
    const lines = [`Edition ${edition.date}: ${edition.status || "waiting"}. ${selected} of ${edition.topics.length} stories included.`];
    if (state.progress) lines.push(`${state.progress.percent ?? 0}%: ${state.progress.message}`);
    else lines.push(edition.buildPaused ? "Generation is paused." : "No generation job is running.");
    if (edition.generationRetry) lines.push(`Automatic retry ${edition.generationRetry.attempt}: ${edition.generationRetry.error || edition.generationRetry.message || "the last stage will be retried"}.`);
    if (edition.error) lines.push(`Last error: ${edition.error}`);
    if (state.model) lines.push(`Configured model: ${state.model}${state.localModel ? " (local)" : ""}.`);
    if (state.locked) lines.push("This edition is locked for publishing. Questions are available; open a new revision to edit stories.");
    return lines.join("\n");
  }
  if (/^(?:list (?:the )?stories|show (?:me )?(?:the )?(?:rundown|lineup)|what(?:'s| is) in (?:the )?(?:rundown|lineup|episode)|what stories (?:are (?:we covering|included)|do we have))$/u.test(text)) {
    if (!edition.topics.length) return `The ${edition.date} rundown is empty. Tell me a headline and any reporting notes or source link to add a story. Non-sports stories can go in Other news.`;
    return edition.topics.map((topic, i) => `${i + 1}. ${topic.title}${topic.league ? ` (${topic.league})` : ""} — ${topic.selected ? "included" : "excluded"}${topic.skipReason ? `; ${topic.skipReason}` : ""}`).join("\n");
  }
  return null;
}

export function directEditorialSelection(content, focusedTopicId) {
  if (!focusedTopicId) return null;
  const match = /^(?:please\s+|(?:can|could|would) you\s+)?(include|exclude|drop|remove)\s+(?:this (?:story|topic|segment)|it)\b/iu.exec(content.trim());
  if (!match || /\b(?:and|also|then)\b/iu.test(content)
    || (content.match(/\b(?:include|exclude|drop|remove)\b/giu) || []).length !== 1) return null;
  return { reply: "", edits: [{ id: focusedTopicId, selected: match[1].toLowerCase() === "include" }] };
}
