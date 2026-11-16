const topics = [
 
];

// Evergreen placeholders for a desk with no research model. They are benched
// automatically once a slate scan pitches a verified recap.
export function sampleTopics() {
  return structuredClone(topics).map((topic) => ({ ...topic, practice: true }));
}

// The practice edition: scripted stories from scanned evidence render as
// factual segments bound to their claims; plain topics render as attributed
// opinion from the editorial take.
// A story scanned from evidence renders from its own script, with Isaac's
// take attributed after it. No model is involved.
export function scriptedSegment(topic) {
  return {
    id: topic.eventId || undefined, topicId: topic.id, eventId: topic.eventId || null,
    headline: topic.script.headline, narration: [topic.script.narration, topic.take?.trim() && `Isaac’s take. ${topic.take.trim()}`].filter(Boolean).join("\n\n"),
    sources: topic.sources, diagram: topic.script.diagram || undefined,
  };
}

export function sampleEpisode({ topics }) {
  const segments = topics.filter((topic) => topic.selected && (topic.script || topic.take)).map((topic) => topic.script ? scriptedSegment(topic) : {
    topicId: topic.id, headline: topic.title, narration: topic.take, sources: topic.sources, opinion: true,
  });
  if (!segments.length) throw new Error("Include a topic with an editorial take or scanned evidence to render the practice edition.");
  return { title: "Overtime Desk | Practice Edition", description: "A practice broadcast with evergreen sports commentary.", segments };
}
