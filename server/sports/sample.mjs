const topics = [
  {
    id: "fourth-down", title: "The fourth-down call starts with field position",
    summary: "A football segment about how the same distance to go can mean very different things depending on where the ball is spotted.",
    take: "Start with where a failed conversion leaves the defense. Then weigh the distance, the score and the clock. The interesting debate starts when those factors point in different directions.",
    selected: true,
    sources: [{ title: "NFL rulebook", publisher: "NFL Football Operations", url: "https://operations.nfl.com/the-rules/nfl-rulebook/", excerpt: "" }],
  },
  {
    id: "next-pass", title: "The pass after the pass against a ball-screen blitz",
    summary: "A basketball segment on what the offense can do after two defenders commit to the ball handler.",
    take: "Watch the weak-side defender. If they tag the roll, the next pass goes to the corner. If they stay home, the roller can finish. The first pass escapes pressure and the second one makes the defense pay.",
    selected: true,
    sources: [{ title: "NBA stats glossary", publisher: "NBA", url: "https://www.nba.com/stats/help/glossary", excerpt: "" }],
  },
  {
    id: "bullpen", title: "What a bullpen day asks of a manager",
    summary: "A baseball segment on sequencing pitchers and planning which parts of the batting order each one will face.",
    take: "I would map the first three trips through the lineup before I assign anyone an inning. The matchup that matters most could arrive in the fifth.",
    selected: false,
    sources: [{ title: "Relief pitcher", publisher: "MLB", url: "https://www.mlb.com/glossary/positions/relief-pitcher", excerpt: "" }],
  },
];

export function sampleTopics() {
  return structuredClone(topics);
}

export function sampleEpisode({ topics }) {
  const segments = topics.filter((topic) => topic.selected && topic.take).map((topic) => ({
    headline: topic.title,
    narration: topic.take,
    sources: topic.sources,
  }));
  if (!segments.length) throw new Error("Include a topic with an editorial take to render the practice edition.");
  return { title: "Overtime Desk | Practice Edition", description: "A practice broadcast with evergreen sports commentary.", segments };
}
