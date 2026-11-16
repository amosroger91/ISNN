import assert from "node:assert/strict";
import test from "node:test";
import { draftIsaacTake, editTopics, researchEdition, writeAnchorScript, writeEpisode } from "../server/sports/research.mjs";

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
  assert.match(prompt, /limited to NCAA, NBA, MLB/u);
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
  }), /No recent, usable sports articles.*League report returned HTTP 503/);
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
      assert.match(data.stories[0].narration, /Isaac’s take\. I would keep Vega in the closing lineup\./u);
      return modelResponse(issueCheck);
    },
  });
  assert.equal(modelCalls, 2);
  assert.deepEqual(draft.segments[0].sources, [source]);
  await assert.rejects(writeEpisode({ date, topics: [{ ...topic, takeScript: "", sources: [{ ...source, excerpt: "" }] }] }, {
    now,
    fetchImpl: async (_url, request) => request.method === "POST" ? modelResponse({ matches: [] }) : new Response(rss()),
  }), /needs reported evidence or a saved take script/);
  await assert.rejects(writeEpisode({ date, topics: [{ ...topic, sources: [] }] }, {
    fetchImpl: async () => modelResponse({ approved: false, issues: ["Unsupported factual assertion."] }),
  }), /Unsupported factual assertion/);
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
  const grounded = await writeEpisode({ date, topics: [topic] }, {
    fetchImpl: async (_url, request) => {
      const system = JSON.parse(request.body).messages[0].content;
      if (system.startsWith("You are a sports copy editor")) return modelResponse(issueCheck);
      return modelResponse({
        title: "Sparks win",
        description: "The Sparks won at home.",
        segments: [{ number: 1, headline: "Sparks win", narration: "The Sparks won 91–87.", sourceIds: [1] }],
      });
    },
  });
  assert.match(grounded.segments[0].narration, /81–77/);
  assert.doesNotMatch(grounded.segments[0].narration, /91/);
  const kept = await writeEpisode({ date, topics: [topic] }, {
    fetchImpl: async (_url, request) => {
      const system = JSON.parse(request.body).messages[0].content;
      if (system.startsWith("You are a sports copy editor")) return modelResponse({ approved: false, issues: ["The score is not in the source."] });
      return modelResponse({
        title: "Sparks win",
        description: "The Sparks won at home.",
        segments: [{ number: 1, headline: "Sparks win", narration: "The Sparks won 81–77.", sourceIds: [1] }],
      });
    },
  });
  assert.match(kept.segments[0].narration, /81–77/);
});

test("a timed-out broadcast check is retried, and a sourced script still airs if the checker stays down", async (t) => {
  settings(t);
  const script = {
    title: "Sparks win",
    description: "The Sparks won at home.",
    segments: [{ number: 1, headline: "Sparks win", narration: "The Sparks won 81–77.", sourceIds: [1] }],
  };
  const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  let checks = 0;
  const retried = await writeEpisode({ date, topics: [topic] }, {
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
  });
  assert.equal(checks, 2);
  assert.match(retried.segments[0].narration, /81–77/);
  let exhausted = 0;
  const keptAnyway = await writeEpisode({ date, topics: [topic] }, {
    retryDelayMs: 0,
    fetchImpl: async (_url, request) => {
      const system = JSON.parse(request.body).messages[0].content;
      if (system.startsWith("You are a sports copy editor")) {
        exhausted += 1;
        throw timeout();
      }
      return modelResponse(script);
    },
  });
  assert.equal(exhausted, 3);
  assert.match(keptAnyway.segments[0].narration, /81–77/);
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
