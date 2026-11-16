import assert from "node:assert/strict";
import test from "node:test";
import { editTopics, researchEdition, writeEpisode } from "../server/sports/research.mjs";

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
  take: "I would keep Vega in the closing lineup.",
  sources: [source],
};
const modelResponse = (body) => Response.json({ choices: [{ message: { content: JSON.stringify(body) } }] });

function settings(t) {
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

test("broadcast treats editor notes as framing and preserves Isaac's attributed take", async (t) => {
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
  await assert.rejects(writeEpisode({ date, topics: [{ ...topic, take: "", sources: [{ ...source, excerpt: "" }] }] }, {
    now,
    fetchImpl: async (_url, request) => request.method === "POST" ? modelResponse({ matches: [] }) : new Response(rss()),
  }), /needs reported evidence or an explicit editorial take/);
  await assert.rejects(writeEpisode({ date, topics: [{ ...topic, sources: [] }] }, {
    fetchImpl: async () => modelResponse({ approved: false, issues: ["Unsupported factual assertion."] }),
  }), /Unsupported factual assertion/);
});

test("new factual topics can gain coverage from configured feeds without visiting editor links", async (t) => {
  settings(t);
  let modelCalls = 0;
  const draft = await writeEpisode({
    date,
    topics: [{ ...topic, summary: "Focus on Vega’s scoring.", take: "", sources: [{ ...source, excerpt: "" }] }],
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
  await assert.rejects(writeEpisode({ date, topics: [topic] }, {
    fetchImpl: async () => modelResponse({
      title: "Sparks win",
      description: "The Sparks won at home.",
      segments: [{ number: 1, headline: "Sparks win", narration: "The Sparks won 91–87.", sourceIds: [1] }],
    }),
  }), /number absent from its cited sources/);
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
