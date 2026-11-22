import assert from "node:assert/strict";
import test from "node:test";
import { articleReporting, draftIsaacTake, editTopics, releaseResearchModel, researchEdition, writeAnchorScript, writeEpisode } from "../server/sports/research.mjs";

const now = new Date("2026-11-16T06:00:00Z");
const date = "2026-11-16";
const issueCheck = { approved: true, issues: [] };
const source = {
  title: "Sparks win at home",
  publisher: "League report",
  url: "https://league.example/reports/sparks",
  excerpt: "The Sparks won 81–77. Vega scored 24 points.",
};
const topic = {
  id: "1677f8f6-b7d9-4132-9c25-b73852299c45",
  title: "Sparks hold on",
  summary: "An editor note that says the game was in another stadium.",
  selected: true,
  take: "closing lineup: Vega",
  takeScript: "I would keep Vega in the closing lineup.",
  sources: [source],
};
const modelResponse = (body) => Response.json({ choices: [{ message: { content: JSON.stringify(body) } }] });

function settings(t) {
  for (const key of ["SPORTS_LLM_API", "SPORTS_LLM_FALLBACK_MODEL", "SPORTS_LLM_API_KEY"]) {
    const previous = process.env[key];
    delete process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  for (const [key, value] of Object.entries({
    SPORTS_LLM_URL: "https://model.example/v1",
    SPORTS_FEEDS: JSON.stringify([{ publisher: "League report", url: "https://league.example/feed" }]),
  })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}

function feedItem(title, pubDate, link = "https://league.example/results?a=1&amp;utm_source=feed#top") {
  return `<item><title><![CDATA[${title}]]></title><pubDate>${pubDate}</pubDate>
    <link>${link}</link><description><![CDATA[<p>Vega &amp; the Sparks won 81–77.</p>]]></description></item>`;
}
const rss = () => `<?xml version="1.0"?><rss version="2.0"><channel>
  ${feedItem("Sparks win at home", "Mon, 16 Nov 2026 02:00:00 GMT")}
  ${feedItem("Sportsbook promo code", "Mon, 16 Nov 2026 03:00:00 GMT", "https://league.example/odds")}
  ${feedItem("Last week's news", "Mon, 09 Nov 2026 02:00:00 GMT", "https://league.example/old")}
</channel></rss>`;

test("fuller reporting comes from article bodies rather than navigation and related stories", () => {
  const body = "Arkansas State fired Butch Jones after a loss to Coastal Carolina left the Red Wolves at 4-6.";
  assert.equal(articleReporting(`<nav><p>Unrelated team wins a championship in another sport.</p></nav><article id="Article-body"><p>${body}</p><aside><p>A different team made a trade that is unrelated to this report.</p></aside></article>`), body);
  assert.equal(articleReporting(`<script type="application/ld+json">${JSON.stringify({ "@type": "NewsArticle", articleBody: body })}</script>`), body);
  assert.equal(articleReporting("<html><p>A page without an article body must not become story evidence.</p></html>"), "");
});

test("the writer receives fuller publisher reporting and keeps it with the script's citations", async (t) => {
  settings(t);
  const url = "https://www.cbssports.com/college-football/news/arkansas-state/";
  const article = "Arkansas State fired Butch Jones after the Red Wolves dropped to 4-6 following a loss to Coastal Carolina.";
  const source = { title: "Arkansas State fires Butch Jones", url, publisher: "CBS Sports", excerpt: "Arkansas State dropped to 4-6." };
  const result = await writeEpisode({ date, topics: [{ ...topic, take: "", takeScript: "", sources: [source] }] }, {
    fetchImpl: async (requested, request) => {
      if (request.method !== "POST") {
        assert.equal(requested, url);
        assert.equal(request.redirect, "error");
        return new Response(`<article><p>${article}</p></article>`, { headers: { "Content-Type": "text/html" } });
      }
      const payload = JSON.parse(request.body);
      if (payload.messages[0].content.startsWith("You are a sports copy editor")) return modelResponse(issueCheck);
      assert.match(JSON.parse(payload.messages[1].content).stories[0].sources[0].excerpt, /Coastal Carolina/u);
      return modelResponse({ title: source.title, description: "Arkansas State changes coaches.", segments: [{ number: 1, headline: source.title, narration: "Arkansas State fired Butch Jones. A loss to Coastal Carolina left the Red Wolves at 4-6.", sourceIds: [1] }] });
    },
  });
  assert.match(result.segments[0].sources[0].excerpt, /Coastal Carolina/u);
});

test("research uses only current, nonpromotional feed evidence and keeps original source links", async (t) => {
  settings(t);
  let modelCalls = 0;
  const topics = await researchEdition(date, {
    now,
    fetchImpl: async (url, request) => {
      if (request.method !== "POST") return new Response(rss());
      assert.equal(String(url), "https://model.example/v1/chat/completions");
      const data = JSON.parse(JSON.parse(request.body).messages[1].content);
      if (++modelCalls === 1) {
        assert.deepEqual(data.evidence, [{
          id: 1,
          title: "Sparks win at home",
          url: "https://league.example/results?a=1",
          publisher: "League report",
          excerpt: "Vega & the Sparks won 81–77.",
          publishedAt: "2026-11-16T02:00:00.000Z",
        }]);
        return modelResponse({ topics: [{ title: "Sparks win", summary: "The Sparks won 81–77.", sourceIds: [1] }] });
      }
      assert.equal(data.stories[0].sources[0].title, "Sparks win at home");
      return modelResponse(issueCheck);
    },
  });
  assert.equal(modelCalls, 2);
  assert.equal(topics[0].selected, true);
  assert.equal(topics[0].take, "");
  assert.equal(topics[0].sources[0].url, "https://league.example/results?a=1");
});

test("the default feeds and the research prompt follow the coverage scope", async (t) => {
  for (const key of ["SPORTS_FEEDS", "SPORTS_LEAGUES"]) {
    const previous = process.env[key];
    delete process.env[key];
    t.after(() => { if (previous !== undefined) process.env[key] = previous; });
  }
  process.env.SPORTS_LLM_URL = "https://model.example/v1";
  t.after(() => delete process.env.SPORTS_LLM_URL);
  const feeds = [];
  let prompt = "";
  await researchEdition(date, {
    now,
    fetchImpl: async (url, request) => {
      if (request.method !== "POST") {
        feeds.push(String(url));
        return new Response(rss());
      }
      prompt ||= JSON.parse(request.body).messages[0].content;
      return modelResponse({ topics: [{ title: "Sparks win at home", summary: "The Sparks won 81–77.", sourceIds: [1] }] });
    },
  }).catch(() => {});
  assert.ok(feeds.some((url) => url.includes("/nba")) && feeds.some((url) => url.includes("/mlb")) && feeds.some((url) => url.includes("college-football")) && feeds.some((url) => url.includes("college-basketball")));
  assert.ok(!feeds.some((url) => url.includes("/nfl") || url.includes("bbci")));
  assert.ok(feeds.includes("https://www.ufc.com/rss/news"), "UFC is researched every day");
  assert.match(prompt, /limited to NCAA, NBA, MLB, UFC/u);
  assert.match(prompt, /For UFC, pick only the single best story of the day/u);
});

test("UFC keeps its best story as one selected candidate within the daily shortlist", async (t) => {
  settings(t);
  process.env.SPORTS_FEEDS = JSON.stringify([
    { publisher: "League report", url: "https://league.example/feed", league: "NBA", sport: "basketball" },
    { publisher: "UFC.com", url: "https://fights.example/feed", league: "UFC", sport: "mma" },
  ]);
  const fights = `<?xml version="1.0"?><rss version="2.0"><channel>
    ${feedItem("Title fight booked for UFC 330", "Mon, 16 Nov 2026 02:30:00 GMT", "https://fights.example/title")}
    ${feedItem("Prelim results from Saturday", "Mon, 16 Nov 2026 02:10:00 GMT", "https://fights.example/prelims")}
    ${feedItem("Veteran announces retirement", "Mon, 16 Nov 2026 02:05:00 GMT", "https://fights.example/retire")}
  </channel></rss>`;
  const topics = await researchEdition(date, {
    now,
    fetchImpl: async (url, request) => {
      if (request.method !== "POST") return new Response(String(url).includes("fights") ? fights : rss());
      const data = JSON.parse(JSON.parse(request.body).messages[1].content);
      if (data.evidence) {
        const id = (link) => data.evidence.find((article) => article.url === link).id;
        return modelResponse({ topics: [
          { title: "Sparks win", summary: "The Sparks won 81–77.", sourceIds: [id("https://league.example/results?a=1")], league: "NBA" },
          { title: "Title fight booked", summary: "A title fight is set.", sourceIds: [id("https://fights.example/title")], league: "UFC" },
          { title: "Prelim results", summary: "Saturday's prelims.", sourceIds: [id("https://fights.example/prelims")], league: "UFC" },
        ] });
      }
      return modelResponse(issueCheck);
    },
  });
  const ufc = topics.filter(({ league }) => league === "UFC");
  assert.equal(ufc.length, 1, "one UFC story, and the backfill adds no second one");
  assert.equal(ufc[0].title, "Title fight booked");
  assert.equal(ufc[0].selected, true);
  assert.equal(ufc[0].sport, "mma");
  assert.ok(topics.filter(({ league }) => league === "NBA").every(({ selected }) => selected));
});

test("daily research fills twenty distinct candidates including one UFC, even when the model underfills", async (t) => {
  settings(t);
  const headlines = {
    NBA: ["Lakers complete center trade", "Celtics announce arena renovation", "Knicks guard returns Friday", "Warriors recruit assistant coach", "Nuggets reveal playoff rotation", "Bucks suspend veteran forward", "Pistons extend talented prospect"],
    MLB: ["Yankees acquire relief pitcher", "Dodgers introduce analytics director", "Mets choose interim manager", "Braves unveil spring facility", "Phillies announce ownership expansion", "Cubs finalize broadcasting agreement", "Mariners prospect earns promotion"],
    NCAAF: ["Oregon confirms coaching departure", "Alabama unveils stadium expansion", "Michigan elects team captain", "Georgia signs transfer quarterback", "Clemson changes defensive scheme", "Texas opens training complex", "Penn State releases academic report"],
    UFC: ["Moreno signs championship bout", "Adesanya confirms retirement decision", "Pereira withdraws following injury"],
  };
  process.env.SPORTS_FEEDS = JSON.stringify(Object.keys(headlines).map((league) => ({ publisher: "League report", url: `https://feeds.example/${league}`, league, sport: league === "UFC" ? "mma" : league === "NBA" ? "basketball" : league === "MLB" ? "baseball" : "football" })));
  const run = (full, existing = []) => researchEdition(date, { now, existing, fetchImpl: async (url, request) => {
    if (request.method !== "POST") {
      const league = new URL(url).pathname.slice(1);
      return new Response(`<rss version="2.0"><channel>${headlines[league].map((title, i) => `<item><title>${title}</title><pubDate>Mon, 16 Nov 2026 02:00:00 GMT</pubDate><link>https://news.example/${league}/${i}</link><description>The league confirmed: ${title}.</description></item>`).join("")}</channel></rss>`);
    }
    const input = JSON.parse(JSON.parse(request.body).messages[1].content);
    if (!input.evidence) return modelResponse(issueCheck);
    assert.match(JSON.parse(request.body).messages[0].content, /20 genuinely distinct/u);
    const chosen = full ? input.evidence.filter(({ league }) => league !== "UFC").slice(0, 19).concat(input.evidence.find(({ league }) => league === "UFC")) : [input.evidence.find(({ league }) => league === "NBA")];
    return modelResponse({ topics: chosen.map((article) => ({ title: `${article.title} update`, summary: article.excerpt, sourceIds: [article.id], league: article.league })) });
  } });
  const underfilled = await run(false);
  assert.equal(underfilled.length, 20);
  assert.equal(underfilled.filter(({ league }) => league === "UFC").length, 1);
  assert.ok(underfilled.every(({ selected, sources }) => selected && sources.length));
  assert.equal(new Set(underfilled.flatMap(({ sources }) => sources.map(({ url }) => url))).size, 20);
  const full = await run(true);
  assert.equal(full.length, 20);
  assert.equal(full.filter(({ title }) => title.endsWith(" update")).length, 20, "model picks after the old tenth-item cap survive");
  assert.equal(full.filter(({ league }) => league === "UFC").length, 1);
  const remainder = await run(false, underfilled.slice(0, 5));
  assert.equal(remainder.length, 15, "existing or calendar stories occupy slots within the same twenty");
  assert.ok(remainder.every((topic) => !underfilled.slice(0, 5).some((old) => old.sources[0].url === topic.sources[0].url)));
  assert.equal([...underfilled.slice(0, 5), ...remainder].filter(({ league }) => league === "UFC").length, 1);
});

test("Ollama script requests constrain the story and source IDs within a small context", async (t) => {
  settings(t);
  process.env.SPORTS_LLM_API = "ollama";
  let calls = 0;
  await writeEpisode({ date, topics: [topic] }, { fetchImpl: async (_url, request) => {
    const body = JSON.parse(request.body);
    assert.equal(body.options.num_ctx, 4096);
    assert.equal(body.options.num_batch, 128);
    let output;
    if (++calls === 1) {
      assert.equal(body.format.properties.segments.maxItems, 1);
      assert.deepEqual(body.format.properties.segments.items.properties.number.enum, [1]);
      assert.deepEqual(body.format.properties.segments.items.properties.sourceIds.items.enum, [1]);
      output = { title: "Sparks win", description: "The Sparks won at home.", segments: [{ number: 1, headline: "Sparks win", narration: "The Sparks won 81–77.", sourceIds: [1] }] };
    } else {
      assert.equal(body.format.properties.approved.type, "boolean");
      assert.match(body.messages[0].content, /remembered sports knowledge is not evidence/u);
      output = issueCheck;
    }
    return Response.json({ done_reason: "stop", message: { content: JSON.stringify(output) } });
  } });
  assert.equal(calls, 2);
});

test("only a local Ollama writer is unloaded before GPU narration", async (t) => {
  settings(t);
  process.env.SPORTS_LLM_API = "ollama";
  process.env.SPORTS_LLM_URL = "http://127.0.0.1:11434";
  let calls = 0;
  const fetchImpl = async (url, request) => {
    calls++;
    assert.equal(String(url), "http://127.0.0.1:11434/api/generate");
    assert.equal(JSON.parse(request.body).keep_alive, 0);
    return Response.json({ done: true, done_reason: "unload" });
  };
  await releaseResearchModel({ fetchImpl });
  process.env.SPORTS_LLM_URL = "https://models.example";
  await releaseResearchModel({ fetchImpl });
  assert.equal(calls, 1);
});

test("the anchor pass writes spoken copy from the claims and is audited before it airs", async (t) => {
  settings(t);
  const story = {
    id: "2026-11-15-nba-hcg-rvs", position: "lead story", headline: "Harbor City Gulls 112, River Valley Stags 104: Quill's corner three", draft: "Harbor City Gulls 112, River Valley Stags 104 in NBA regular season.",
    sport: "basketball", league: "NBA", teams: ["River Valley Stags", "Harbor City Gulls"], take: null,
    claims: [{ text: "Final score Harbor City Gulls 112, River Valley Stags 104", value: [112, 104], unit: "points" }],
  };
  const calls = [];
  const result = await writeAnchorScript({ date, segments: [story] }, {
    fetchImpl: async (url, request) => {
      const body = JSON.parse(request.body);
      calls.push(body.messages[0].content.slice(0, 40));
      const input = JSON.parse(body.messages[1].content);
      if (calls.length === 1) {
        assert.equal(input.stories[0].claims[0].value[0], 112);
        assert.match(body.messages[0].content, /Wellspring Media sports anchor Isaac Doss/u);
        assert.match(body.messages[0].content, /never add a fact/u);
        return modelResponse({ segments: [{ id: story.id, narration: "Our lead story this morning: the Gulls held off the Stags 112 to 104 at home." }] });
      }
      assert.equal(input.stories[0].sources[0].excerpt, story.claims[0].text, "the audit checks the copy against the claims");
      return modelResponse(issueCheck);
    },
  });
  assert.equal(calls.length, 2);
  assert.match(result[0].narration, /^Our lead story/u);
  await assert.rejects(writeAnchorScript({ date, segments: [story] }, { fetchImpl: async () => modelResponse({ segments: [{ id: "other", narration: "Some copy for another story entirely." }] }) }), /did not cover every story/u);
  await assert.rejects(writeAnchorScript({ date, segments: [story] }, { fetchImpl: async (_url, request) => {
    return JSON.parse(request.body).messages[0].content.startsWith("You are writing morning sports recap copy")
      ? modelResponse({ segments: [{ id: story.id, narration: "The Gulls won their fifth straight behind Quill." }] })
      : modelResponse({ approved: false, issues: ["The winning streak is not in the evidence."] });
  } }), /winning streak/u);
});

test("a local Ollama model is asked through its native API with thinking off and JSON forced", async (t) => {
  settings(t);
  for (const [key, value] of Object.entries({ SPORTS_LLM_URL: "http://127.0.0.1:11434", SPORTS_LLM_API: "ollama", SPORTS_LLM_MODEL: "qwen3.5:9b", SPORTS_LLM_TIMEOUT_MS: "300000" })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const result = await editTopics({ date, topics: [topic], messages: [] }, "take: Keep Vega in the closing lineup.", topic.id, {
    fetchImpl: async (url, request) => {
      assert.equal(String(url), "http://127.0.0.1:11434/api/chat");
      const body = JSON.parse(request.body);
      assert.equal(body.model, "qwen3.5:9b");
      assert.equal(body.think, false);
      assert.equal(body.format, "json");
      assert.equal(body.stream, false);
      assert.equal(body.messages[0].role, "system");
      return Response.json({ done_reason: "stop", message: { role: "assistant", content: JSON.stringify({ reply: "Noted.", edits: [{ id: topic.id, take: "Keep Vega in the closing lineup." }] }) } });
    },
  });
  assert.equal(result.edits[0].take, "Keep Vega in the closing lineup.");
  await assert.rejects(editTopics({ date, topics: [topic], messages: [] }, "take: x", topic.id, {
    fetchImpl: async () => Response.json({ done_reason: "length", message: { role: "assistant", content: "{" } }),
  }), /invalid response/u);
});

test("a researched story is tagged from its feed and only with clubs named in the article", async (t) => {
  settings(t);
  process.env.SPORTS_FEEDS = JSON.stringify([{ publisher: "CBS Sports", url: "https://www.cbssports.com/rss/headlines/nba", league: "NBA", sport: "basketball" }]);
  const topics = await researchEdition(date, {
    now,
    fetchImpl: async (_url, request) => {
      if (request.method !== "POST") return new Response(rss());
      const data = JSON.parse(JSON.parse(request.body).messages[1].content);
      if (data.evidence) return modelResponse({ topics: [{ title: "Sparks win", summary: "The Sparks won 81–77.", sourceIds: [1], teams: ["Sparks", "Celtics"] }] });
      return modelResponse(issueCheck);
    },
  });
  assert.equal(topics[0].sport, "basketball");
  assert.equal(topics[0].league, "NBA");
  assert.deepEqual(topics[0].teams, ["Sparks"]);
});

test("every league on the show gets at least two stories, grouped by league", async (t) => {
  settings(t);
  process.env.SPORTS_FEEDS = JSON.stringify([
    { publisher: "CBS Sports", url: "https://feeds.example/nba", league: "NBA", sport: "basketball" },
    { publisher: "CBS Sports", url: "https://feeds.example/mlb", league: "MLB", sport: "baseball" },
  ]);
  const item = (title, link, excerpt, hour) => `<item><title>${title}</title><pubDate>Mon, 16 Nov 2026 0${hour}:00:00 GMT</pubDate><link>${link}</link><description>${excerpt}</description></item>`;
  const feeds = {
    "https://feeds.example/nba": [
      item("Sparks beat Comets in overtime", "https://news.example/nba/sparks", "The Sparks won 81–77 in overtime.", 4),
      item("Sparks edge Comets after overtime thriller", "https://news.example/nba/sparks-2", "Another recap of the Sparks overtime win.", 3),
      item("Hawks guard Rivera out with ankle sprain", "https://news.example/nba/rivera", "Rivera will miss the weekend with an ankle sprain.", 2),
    ],
    "https://feeds.example/mlb": [
      item("Tigers hire new pitching coach", "https://news.example/mlb/coach", "Detroit named a new pitching coach on Sunday.", 4),
      item("Mariners sign veteran reliever", "https://news.example/mlb/reliever", "Seattle agreed to terms with a veteran reliever.", 3),
    ],
  };
  const topics = await researchEdition(date, {
    now,
    fetchImpl: async (url, request) => {
      if (request.method !== "POST") return new Response(`<?xml version="1.0"?><rss version="2.0"><channel>${feeds[String(url)].join("")}</channel></rss>`);
      const data = JSON.parse(JSON.parse(request.body).messages[1].content);
      if (data.evidence) {
        const id = (link) => data.evidence.find(({ url }) => url === link).id;
        // The model leads with MLB, then gives the NBA only one story.
        return modelResponse({ topics: [
          { title: "Tigers hire a pitching coach", summary: "Detroit named a new pitching coach.", sourceIds: [id("https://news.example/mlb/coach")], league: "MLB" },
          { title: "Sparks win in overtime", summary: "The Sparks won 81–77.", sourceIds: [id("https://news.example/nba/sparks")], league: "NBA" },
          { title: "Mariners add a reliever", summary: "Seattle agreed to terms with a veteran reliever.", sourceIds: [id("https://news.example/mlb/reliever")], league: "MLB" },
        ] });
      }
      return modelResponse(issueCheck);
    },
  });
  assert.deepEqual(topics.map(({ league }) => league), ["MLB", "MLB", "NBA", "NBA"]);
  assert.equal(topics[3].title, "Hawks guard Rivera out with ankle sprain", "the second recap of the same game is skipped");
  assert.equal(topics[3].sources[0].url, "https://news.example/nba/rivera");
  assert.equal(topics[3].sport, "basketball");
});

test("a failed audit keeps the cited article wording instead of dropping the rundown", async (t) => {
  settings(t);
  let modelCalls = 0;
  const topics = await researchEdition(date, {
    now,
    fetchImpl: async (_url, request) => {
      if (request.method !== "POST") return new Response(rss());
      if (++modelCalls === 1) return modelResponse({ topics: [{ title: "Sparks win", summary: "The Sparks won 81–77.", sourceIds: ["1"] }] });
      return modelResponse({ approved: false, issues: [`The score is not in the source. ${"x".repeat(400)}`] });
    },
  });
  assert.equal(modelCalls, 2);
  assert.equal(topics[0].title, "Sparks win at home");
  assert.equal(topics[0].summary, "Vega & the Sparks won 81–77.");
});

test("research stops for invented citations or when sources are unavailable", async (t) => {
  settings(t);
  await assert.rejects(researchEdition(date, {
    now,
    fetchImpl: async (_url, request) => request.method === "POST"
      ? modelResponse({ topics: [{ title: "A win", summary: "Summary.", sourceIds: [10] }] })
      : new Response(rss()),
  }), /invalid or repeated source/);
  await assert.rejects(researchEdition(date, {
    now,
    fetchImpl: async () => new Response("", { status: 503 }),
  }), /No recent, usable articles.*League report returned HTTP 503/);
});

test("drafts an on-air take from notes and rejects unsupported numbers", async (t) => {
  settings(t);
  const generated = await draftIsaacTake(topic, {
    fetchImpl: async (_url, request) => {
      const input = JSON.parse(JSON.parse(request.body).messages[1].content);
      assert.equal(input.notes, topic.take);
      return modelResponse({ script: "Keep Vega on for the closing stretch. That gives the offense another option when the defense tightens up." });
    },
  });
  assert.match(generated, /another option/);
  await assert.rejects(draftIsaacTake(topic, {
    fetchImpl: async () => modelResponse({ script: "Vega averaged 37 points in those lineups." }),
  }), /absent from its cited sources/);
});

test("broadcast treats editor notes as framing and preserves Isaac's attributed take script", async (t) => {
  settings(t);
  let modelCalls = 0;
  const draft = await writeEpisode({ date, topics: [topic] }, {
    fetchImpl: async (_url, request) => {
      const data = JSON.parse(JSON.parse(request.body).messages[1].content);
      if (++modelCalls === 1) {
        assert.equal(data.stories[0].editorNotes, topic.summary);
        assert.doesNotMatch(JSON.stringify(data.stories[0].sources), /editor note|closing lineup/);
        assert.doesNotMatch(JSON.stringify(data), /closing lineup/);
        return modelResponse({
          title: "Sparks win",
          description: "The Sparks won a tight one.",
          segments: [{ number: 1, headline: "Sparks 81, opponents 77", narration: "The Sparks won 81–77.", sourceIds: [1] }],
        });
      }
      // The audit reads only the reporting; Isaac's take airs unchecked.
      assert.doesNotMatch(data.stories[0].narration, /closing lineup/u);
      return modelResponse(issueCheck);
    },
  });
  assert.equal(modelCalls, 2);
  assert.match(draft.segments[0].narration, /Isaac’s take\. I would keep Vega in the closing lineup\./u);
  assert.deepEqual(draft.segments[0].sources, [source]);
  await assert.rejects(writeEpisode({ date, topics: [{ ...topic, takeScript: "", sources: [{ ...source, excerpt: "" }] }] }, {
    now,
    fetchImpl: async (_url, request) => request.method === "POST" ? modelResponse({ matches: [] }) : new Response(rss()),
  }), (error) => error.code === "unsourced" && /left out of the episode/u.test(error.message));
  // A take with no source airs as Isaac's own words; the auditor is not asked.
  const takeOnly = await writeEpisode({ date, topics: [{ ...topic, sources: [] }] }, {
    fetchImpl: async () => modelResponse({ approved: false, issues: ["Unsupported factual assertion."] }),
  });
  assert.equal(takeOnly.segments[0].opinion, true);
});

test("Isaac's own take script airs as written with no source and no audit", async (t) => {
  settings(t);
  let calls = 0;
  const draft = await writeEpisode({ date, topics: [{ ...topic, title: "GTA 6 drops", sport: "other", league: "Other news", sources: [], take: "", takeScript: "GTA 6 sold 16 million copies on day one." }] }, {
    fetchImpl: async () => { calls++; return modelResponse({ approved: false, issues: ["Unsupported."] }); },
  });
  assert.equal(calls, 0);
  assert.equal(draft.segments[0].headline, "GTA 6 drops");
  assert.match(draft.segments[0].narration, /16 million copies/u);
  assert.equal(draft.segments[0].opinion, true);
});

test("a drafted take may use numbers from Isaac's own notes", async (t) => {
  settings(t);
  const script = await draftIsaacTake({ title: "GTA 6 drops", take: "sold 16 million on day one, wild", sources: [] }, {
    fetchImpl: async () => modelResponse({ script: "Sixteen million on day one? I think 16 million tells you everything about this launch." }),
  });
  assert.match(script, /16 million/u);
});

test("a custom story's take may use numbers from Isaac's summary, and a stray number is sent back once", async (t) => {
  settings(t);
  const story = {
    title: "Cam Boozer is already a franchise-changing winner",
    summary: "Yaxel Lendeborg managed 11 points on 3-of-11 shooting in a 126–98 loss. Cameron Boozer had 16 points on 6-for-6.",
    take: "Oscar Robinson, Tim Duncan and Larry Bird are the last three rookies to lead a winning team through 16 games",
    sources: [],
  };
  const inputs = [];
  const script = await draftIsaacTake(story, {
    fetchImpl: async (_url, request) => {
      inputs.push(JSON.parse(JSON.parse(request.body).messages[1].content));
      return modelResponse({ script: inputs.length === 1
        ? "Boozer went 6-for-6 and is on a 20-game heater."
        : "Boozer went 6-for-6 while Lendeborg shot 3-of-11 in a 126–98 loss. I'm building around Boozer." });
    },
  });
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].summary, story.summary);
  assert.match(inputs[1].editorialFeedback, /unsupported numbers: 20/u);
  assert.match(script, /126–98/u);
});

test("an unsourced Other news story is matched against news feeds, not the sports feeds", async (t) => {
  settings(t);
  const fetched = [];
  let prompt = "";
  await assert.rejects(writeEpisode({ date, topics: [{ ...topic, title: "GTA 6 release", summary: "The game comes out.", sport: "other", league: "Other news", take: "", takeScript: "", sources: [] }] }, {
    now,
    fetchImpl: async (url, request) => {
      if (request.method === "POST") {
        prompt = JSON.parse(request.body).messages[0].content;
        return modelResponse({ matches: [] });
      }
      fetched.push(new URL(url).hostname);
      return new Response(rss());
    },
  }), (error) => error.code === "unsourced");
  assert.ok(fetched.length);
  assert.ok(fetched.every((host) => ["feeds.bbci.co.uk", "feeds.feedburner.com", "www.gamespot.com"].includes(host)), fetched.join(", "));
  assert.match(prompt, /news researcher/u);
  assert.doesNotMatch(prompt, /Coverage is limited to/u);
});

test("Other news is scripted from its own non-sports evidence without a sports angle", async (t) => {
  settings(t);
  const source = { title: "NASA completes engine test", url: "https://news.example/mission", publisher: "Mission newsroom", excerpt: "NASA completed an engine test for the mission." };
  const draft = await writeEpisode({ date, topics: [{ ...topic, title: source.title, sport: "other", league: "Other news", take: "", takeScript: "", sources: [source] }] }, {
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      if (body.messages[0].content.startsWith("You are a sports copy editor")) return modelResponse(issueCheck);
      assert.match(body.messages[0].content, /any non-sports subject/u);
      assert.equal(JSON.parse(body.messages[1].content).stories[0].league, "Other news");
      return modelResponse({ title: source.title, description: "An update on the engine test.", segments: [{ number: 1, headline: source.title, narration: source.excerpt, sourceIds: [1] }] });
    },
  });
  assert.equal(draft.segments[0].narration, source.excerpt);
});

test("new factual topics can gain coverage from configured feeds without visiting editor links", async (t) => {
  settings(t);
  let modelCalls = 0;
  const draft = await writeEpisode({
    date,
    topics: [{ ...topic, summary: "Focus on Vega’s scoring.", takeScript: "", sources: [{ ...source, excerpt: "" }] }],
  }, {
    now,
    fetchImpl: async (url, request) => {
      if (request.method !== "POST") {
        assert.equal(url, "https://league.example/feed");
        return new Response(rss());
      }
      const data = JSON.parse(JSON.parse(request.body).messages[1].content);
      if (++modelCalls === 1) {
        assert.equal(data.requests[0].framing, "Sparks hold on");
        assert.equal(data.requests[0].editorNotes, "Focus on Vega’s scoring.");
        assert.deepEqual(data.requests[0].links, [source.url]);
        return modelResponse({ matches: [{ number: 1, sourceIds: [1] }] });
      }
      if (modelCalls === 2) return modelResponse({
        title: "Sparks win",
        description: "A home win for the Sparks.",
        segments: [{ number: 1, headline: "Sparks beat the opposition", narration: "The Sparks won 81–77.", sourceIds: [1] }],
      });
      assert.equal(data.stories[0].requestedFocus, "Sparks hold on");
      return modelResponse(issueCheck);
    },
  });
  assert.equal(modelCalls, 3);
  assert.equal(draft.topicSources[0].id, topic.id);
  assert.deepEqual(draft.topicSources[0].sources, draft.segments[0].sources);
  let rewrites = 0;
  const grounded = await writeEpisode({ date, topics: [topic] }, {
    fetchImpl: async (_url, request) => {
      const system = JSON.parse(request.body).messages[0].content;
      if (system.startsWith("You are a sports copy editor")) return modelResponse(issueCheck);
      const input = JSON.parse(JSON.parse(request.body).messages[1].content);
      if (++rewrites > 1) assert.match(input.editorialFeedback, /number absent/u);
      return modelResponse({
        title: "Sparks win",
        description: "The Sparks won at home.",
        segments: [{ number: 1, headline: "Sparks win", narration: rewrites === 1 ? "The Sparks won 91–87." : "The Sparks won 81–77.", sourceIds: [1] }],
      });
    },
  });
  assert.match(grounded.segments[0].narration, /81–77/);
  assert.doesNotMatch(grounded.segments[0].narration, /91/);
  assert.equal(rewrites, 2);
  await assert.rejects(writeEpisode({ date, topics: [topic] }, {
    fetchImpl: async (_url, request) => {
      const system = JSON.parse(request.body).messages[0].content;
      if (system.startsWith("You are a sports copy editor")) return modelResponse({ approved: false, issues: ["The score is not in the source."] });
      return modelResponse({
        title: "Sparks win",
        description: "The Sparks won at home.",
        segments: [{ number: 1, headline: "Sparks win", narration: "The Sparks won 81–77.", sourceIds: [1] }],
      });
    },
  }), (error) => {
    assert.match(error.message, /editorial review/u);
    // The rejected draft rides on the error so Isaac can mark it true.
    assert.equal(error.draft.segments[0].headline, "Sparks win");
    assert.equal(error.draft.segments[0].spoken, "The Sparks won 81–77.");
    assert.ok(error.draft.segments[0].sources.length);
    return true;
  });
});

test("a timed-out broadcast check stops without repeating an exhausted model call", async (t) => {
  settings(t);
  const script = {
    title: "Sparks win",
    description: "The Sparks won at home.",
    segments: [{ number: 1, headline: "Sparks win", narration: "The Sparks won 81–77.", sourceIds: [1] }],
  };
  const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  let checks = 0;
  await assert.rejects(writeEpisode({ date, topics: [topic] }, {
    retryDelayMs: 0,
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      const system = body.messages[0].content;
      if (system.startsWith("You are a sports copy editor")) {
        assert.equal(body.max_tokens, 800);
        if (++checks === 1) throw timeout();
        return modelResponse(issueCheck);
      }
      return modelResponse(script);
    },
  }), /timed out/u);
  assert.equal(checks, 1);
  let exhausted = 0;
  await assert.rejects(writeEpisode({ date, topics: [topic] }, {
    retryDelayMs: 0,
    fetchImpl: async (_url, request) => {
      const system = JSON.parse(request.body).messages[0].content;
      if (system.startsWith("You are a sports copy editor")) {
        exhausted += 1;
        throw timeout();
      }
      return modelResponse(script);
    },
  }), /could not be reached/u);
  assert.equal(exhausted, 1);
});

test("a long rundown is scripted one story at a time and restarted numbering still lines up", async (t) => {
  settings(t);
  const topics = Array.from({ length: 5 }, (_, i) => ({
    ...topic,
    id: `1677f8f6-b7d9-4132-9c25-b73852299c4${i}`,
    title: `Story ${i + 1}`,
    summary: `Notes for story ${i + 1}.`,
    take: "",
    takeScript: "",
    sources: [{ ...source, title: `Source ${i + 1}`, excerpt: "The Sparks won 81–77." }],
  }));
  const batches = [];
  const draft = await writeEpisode({ date, topics }, {
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      const system = body.messages[0].content;
      const input = JSON.parse(body.messages[1].content);
      if (system.startsWith("You are a sports copy editor")) {
        assert.equal(input.stories.length, 5);
        assert.equal(input.title, "Five stories");
        return modelResponse(issueCheck);
      }
      batches.push(input.numbers);
      assert.match(system, new RegExp(`numbered ${input.numbers.join(", ")}`));
      assert.equal(input.stories.length, input.segmentCount);
      if (input.numbers[0] === 1) {
        return modelResponse({
          title: "Five stories",
          description: "A morning slate.",
          segments: [
            { number: 1, headline: "Opened", narration: "The Sparks won 81–77.", sourceIds: [1] },
          ],
        });
      }
      return modelResponse({
        title: "Ignored batch title",
        description: "Ignored.",
        segments: [{ number: 1, headline: ["Opened", "Second", "Third", "Fourth", "Last story"][input.numbers[0] - 1], narration: "The Sparks won 81–77.", sourceIds: [1] }],
      });
    },
  });
  assert.deepEqual(batches, [[1], [2], [3], [4], [5]]);
  assert.equal(draft.title, "Five stories");
  assert.deepEqual(draft.segments.map((segment) => segment.headline), ["Opened", "Second", "Third", "Fourth", "Last story"]);

  await assert.rejects(writeEpisode({ date, topics: topics.slice(0, 4) }, {
    fetchImpl: async (_url, request) => {
      const system = JSON.parse(request.body).messages[0].content;
      if (system.startsWith("You are a sports copy editor")) return modelResponse(issueCheck);
      return modelResponse({
        title: "Short",
        description: "Short.",
        segments: [1, 2, 3].map((number) => ({ number, headline: "Sparks", narration: "The Sparks won 81–77.", sourceIds: [1] })),
      });
    },
  }), /did not cover each selected story in order/);
});

test("editor chat cannot attach fabricated source links or edit unknown topics", async (t) => {
  settings(t);
  const message = "Save this take: play the bench more.";
  const reply = (edits) => ({ fetchImpl: async () => modelResponse({ reply: "Updated.", edits }) });
  const response = await editTopics({ date, topics: [topic] }, message, topic.id,
    reply([{ id: topic.id, take: "play the bench more." }]));
  assert.deepEqual(response.edits, [{ id: topic.id, take: "play the bench more." }]);
  await assert.rejects(editTopics({ date, topics: [topic] }, message, topic.id,
    reply([{ title: "Bench minutes", url: "https://made-up.example/source" }])), /unsupported source link/);
  await assert.rejects(editTopics({ date, topics: [topic] }, message, topic.id,
    reply([{ id: "1e269ab2-eb05-4049-9d6a-21e5794332ab", selected: false }])), /invalid topic edit/);
});

test("the editor receives recent chat separately from the latest instruction", async (t) => {
  settings(t);
  const pending = "My take on the Sparks: give Vega more minutes.";
  const clarifier = "Should I put that on the Sparks topic?";
  const messages = [
    ...Array.from({ length: 7 }, (_, i) => ({ role: "user", content: `Earlier message ${i + 1}` })),
    { role: "user", content: pending },
    { role: "assistant", content: clarifier },
  ];
  await editTopics({ date, topics: [topic], messages }, "Yes.", topic.id, {
    fetchImpl: async (_url, request) => {
      const data = JSON.parse(JSON.parse(request.body).messages[1].content);
      assert.equal(data.editorMessage, "Yes.");
      assert.equal(data.recentConversation.length, 6);
      assert.deepEqual(data.recentConversation.slice(-2), [
        { speaker: "Isaac", text: pending },
        { speaker: "Assistant", text: clarifier },
      ]);
      return modelResponse({ reply: "Updated.", edits: [{ id: topic.id, take: "Give Vega more minutes." }] });
    },
  });
});

test("the evidence limit keeps leading articles from every configured feed", async (t) => {
  settings(t);
  const feeds = Array.from({ length: 8 }, (_, i) => ({ publisher: `Sports desk ${i + 1}`, url: `https://desk-${i + 1}.example/feed` }));
  process.env.SPORTS_FEEDS = JSON.stringify(feeds);
  let modelCalls = 0;
  await researchEdition(date, {
    now,
    fetchImpl: async (url, request) => {
      if (request.method !== "POST") {
        const { origin } = new URL(url);
        const items = Array.from({ length: 7 }, (_, i) => feedItem(
          "Sparks win at home", `Mon, 16 Nov 2026 00:${String(59 - i).padStart(2, "0")}:00 GMT`, `${origin}/news/${i}`,
        ));
        return new Response(`<rss version="2.0"><channel>${items.join("")}</channel></rss>`);
      }
      if (++modelCalls !== 1) return modelResponse(issueCheck);
      const { evidence } = JSON.parse(JSON.parse(request.body).messages[1].content);
      assert.equal(evidence.length, 40);
      assert.deepEqual(evidence.slice(0, 8).map(({ publisher }) => publisher), feeds.map(({ publisher }) => publisher));
      return modelResponse({ topics: [{ title: "Sparks win", summary: "The Sparks won 81–77.", sourceIds: [1] }] });
    },
  });
});

test("betting columns are dropped from the feeds, while trades for draft picks stay", async (t) => {
  settings(t);
  const item = (title, link) => `<item><title>${title}</title><pubDate>Mon, 16 Nov 2026 03:00:00 GMT</pubDate><link>${link}</link><description>Story text.</description></item>`;
  let evidence = [];
  await researchEdition(date, {
    now,
    fetchImpl: async (_url, request) => {
      if (request.method !== "POST") return new Response(`<?xml version="1.0"?><rss version="2.0"><channel>${[
        item("Rockets vs. Heat NBA picks: A win streak will end", "https://news.example/nba/picks"),
        item("Heat look sharp in win", "https://news.example/betting/news/heat"),
        item("Hawks trade two first-round picks to Jazz", "https://news.example/nba/trade"),
      ].join("")}</channel></rss>`);
      const data = JSON.parse(JSON.parse(request.body).messages[1].content);
      if (data.evidence) {
        evidence = data.evidence.map(({ url }) => url);
        return modelResponse({ topics: [{ title: "Hawks trade picks", summary: "The Hawks traded picks.", sourceIds: [1] }] });
      }
      return modelResponse(issueCheck);
    },
  });
  assert.deepEqual(evidence, ["https://news.example/nba/trade"]);
});

// 2026-11-22: the edition was uploaded the night before, so the 8 a.m. show
// needed a fresh rundown. Researching again after an upload never repeats an
// aired story: its articles are not offered and the model is told.
test("re-researching after an upload offers none of the aired stories' articles", async (t) => {
  settings(t);
  const titles = ["Lakers arena lease","Celtics charter flight","Knicks jersey patch","Warriors practice facility","Nuggets radio deal","Bucks ticket prices","Pistons mascot audition","Heat rookie camp","Suns medical staff","Kings dance team","Hawks parking garage","Bulls scoreboard upgrade","Cavaliers broadcast booth","Mavericks season opener","Rockets youth clinic","Pacers draft lottery","Clippers ownership stake","Grizzlies summer league","Timberwolves film room","Pelicans city council","Thunder hall of fame","Magic anthem singer","Sixers court design","Blazers travel schedule","Spurs team doctor","Raptors logo refresh","Jazz food vendors","Wizards weight room","Hornets ring ceremony","Nets fan festival"];
  process.env.SPORTS_FEEDS = JSON.stringify([{ publisher: "League report", url: "https://feeds.example/NBA", league: "NBA", sport: "basketball" }]);
  const aired = titles.slice(0, 20).map((title, i) => ({ title, league: "NBA", sources: [{ url: `https://news.example/NBA/${i}`, title }] }));
  let offered = null;
  let told = null;
  const topics = await researchEdition(date, { now, existing: [], aired, fetchImpl: async (url, request) => {
    if (request.method !== "POST") {
      return new Response(`<rss version="2.0"><channel>${titles.map((title, i) => `<item><title>${title}</title><pubDate>Mon, 16 Nov 2026 02:00:00 GMT</pubDate><link>https://news.example/NBA/${i}</link><description>The league confirmed: ${title}.</description></item>`).join("")}</channel></rss>`);
    }
    const body = JSON.parse(request.body);
    const input = JSON.parse(body.messages[1].content);
    if (!input.evidence) return modelResponse(issueCheck);
    offered = input.evidence.map(({ url }) => url);
    told = { prompt: body.messages[0].content, aired: input.aired };
    return modelResponse({ topics: input.evidence.slice(0, 3).map((article) => ({ title: article.title, summary: article.excerpt, sourceIds: [article.id], league: "NBA" })) });
  } });
  assert.equal(offered.length, 10, "only the ten unaired articles are offered");
  assert.ok(offered.every((url) => Number(url.split("/").pop()) >= 20));
  assert.equal(told.aired.length, 20);
  assert.match(told.prompt, /already went out on this show today/u);
  assert.ok(topics.length > 0, "new stories come back");
  assert.ok(topics.every(({ sources }) => sources.every(({ url }) => Number(url.split("/").pop()) >= 20)), "no aired story comes back");
});
