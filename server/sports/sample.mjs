const topics = [
 
];

// Evergreen placeholders for a desk with no research model. They are benched
// automatically once a slate scan pitches a verified recap.
export function sampleTopics() {
  return structuredClone(topics).map((topic) => ({ ...topic, practice: true }));
}

export function takeNarration(topic) {
  const script = topic.takeScript?.trim().replace(/\s+/gu, " ");
  return script ? `Isaac’s take. ${script}` : "";
}

export function scriptedSegment(topic) {
  return {
    id: topic.eventId || undefined, topicId: topic.id, eventId: topic.eventId || null,
    headline: topic.script.headline, narration: [topic.script.narration, takeNarration(topic)].filter(Boolean).join("\n\n"),
    sources: topic.sources, diagram: topic.script.diagram || undefined,
  };
}

export function opinionSegment(topic) {
  return { topicId: topic.id, headline: topic.title, narration: takeNarration(topic), sources: topic.sources, opinion: true };
}

export function sampleEpisode({ topics }) {
  const segments = topics.filter((topic) => topic.selected && (topic.script || takeNarration(topic)))
    .map((topic) => topic.script ? scriptedSegment(topic) : opinionSegment(topic));
  if (!segments.length) throw new Error("Include a topic with a take script or scanned evidence to render the practice edition.");
  return { title: "Wellspring Media Sports | Practice Edition", description: "A practice broadcast with evergreen sports commentary.", segments };
}
