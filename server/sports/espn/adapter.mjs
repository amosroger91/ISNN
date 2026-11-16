import { EspnClient, LEAGUES, espnLeagues } from "./client.mjs";
import { applySummary, normalizeEvent } from "./normalize.mjs";
import { rankGames } from "./rank.mjs";
import { editionWindow, inEditionWindow, shiftDate } from "./time.mjs";

// ESPN's public scoreboard behind the evidence port. Facts may be verified.
// Articles, images, and video are not cleared for display, model use, or archive.
export class EspnEvidenceAdapter {
  constructor({ client, leagues, timezone = process.env.SPORTS_TIMEZONE || "America/Chicago", log = (line) => console.log(JSON.stringify(line)), assets = null } = {}) {
    this.name = "espn";
    this.capabilities = { schedule: true, boxscore: true, playByPlay: true, changes: false, network: !client?.fixtures };
    this.contract = { allowedUses: ["verify"], retention: "full" };
    this.client = client || new EspnClient();
    this.leagueKeys = leagues || espnLeagues();
    this.timezone = timezone;
    this.log = log;
    this.assets = assets;
    this.leagueFailures = [];
    this.byId = new Map();
  }

  async listGames({ date, timezone = this.timezone } = {}) {
    this.leagueFailures = [];
    this.byId = new Map();
    const dates = [shiftDate(date, -1), date];
    for (const leagueKey of this.leagueKeys) {
      const league = LEAGUES[leagueKey];
      let boards = 0;
      let lastError = null;
      for (const day of dates) {
        try {
          const body = await this.client.scoreboard(leagueKey, day);
          boards += 1;
          for (const event of body?.events || []) {
            if (this.byId.has(String(event.id))) continue;
            const game = normalizeEvent(event, leagueKey, timezone);
            if (!game || !inEditionWindow(game.startTime, date, timezone)) continue;
            this.byId.set(game.id, game);
          }
        } catch (error) {
          lastError = error;
        }
      }
      if (!boards && lastError) {
        this.leagueFailures.push({ league: league?.league || leagueKey, sport: league?.sport || null, reason: lastError.message });
      }
    }
    const games = rankGames([...this.byId.values()]);
    await this.cachePitched(games);
    const window = editionWindow(date, timezone);
    this.log({
      scan: {
        date, window, games: games.length,
        covered: games.filter((game) => game.story).length,
        withheld: games.filter((game) => game.status !== "final").length,
        failed: this.leagueFailures.map((failure) => failure.league),
      },
    });
    return games.map(({ id, league, sport, competition, status, startTime, home, away }) => ({ id, league, sport, competition, status, startTime, home, away }));
  }

  async gameEvidence(gameId) {
    const game = this.byId.get(String(gameId));
    if (!game) throw Object.assign(new Error(`Unknown game ${gameId}.`), { status: 404 });
    if (game.shortlist) {
      try {
        const summary = await this.client.summary(game.leagueKey, game.id);
        if (summary) applySummary(game, summary);
      } catch (error) {
        game.story = undefined;
        game.hold = { coverage: "awaiting verification", reason: `The summary did not load: ${error.message}` };
      }
    }
    if (game.story) await this.cachePitched([game]);
    return { game };
  }

  // A cache miss or a full disk must not drop the slate. The stills stay unlicensed.
  async cachePitched(games) {
    if (!this.assets) return;
    for (const game of games) {
      if (!game.story) continue;
      try {
        await this.assets.cacheGame(game);
      } catch (error) {
        this.log({ asset: { game: game.id, error: error.message } });
      }
    }
  }
}
