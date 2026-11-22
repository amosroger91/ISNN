import path from "node:path";
import { root } from "../config.mjs";

const directory = path.join(root, "assets", "sports", "footage");
const usGovernment = {
  license: "U.S. public domain",
  licenseUrl: "https://www.usa.gov/government-copyright",
};

// Clips the desk owner added to the project. They come before anything found
// online: team clips for stories about that team, and stock clips (no team) as
// the background for a sport, or for any news story, when nothing more specific
// is found. Stock clips loop to fill the story and may run under more than one.
const library = path.join(directory, "library");
const owner = { creator: "Wellspring Media", license: "Wellspring Media library", licenseUrl: null, library: true };
export const footageLibrary = [
  { ...owner, id: "library-heat-basketball", file: path.join(library, "heat-basketball.mp4"), sport: "basketball", teams: ["miami heat"], title: "Miami Heat" },
  { ...owner, id: "library-michigan-state-football", file: path.join(library, "michigan-state-football.mp4"), sport: "football", teams: ["michigan state spartans"], title: "Michigan State Football" },
  { ...owner, id: "library-eagles-football", file: path.join(library, "eagles-football.mp4"), sport: "football", teams: ["philadelphia eagles"], title: "Philadelphia Eagles" },
  { ...owner, id: "library-basketball-hoop", file: path.join(library, "basketball-hoop-1.mp4"), sport: "basketball", stock: true, orientation: "landscape", title: "" },
  { ...owner, id: "library-basketball-hoop-vertical", file: path.join(library, "basketball-hoop.mp4"), sport: "basketball", stock: true, orientation: "portrait", title: "" },
  { ...owner, id: "library-ufc-training", file: path.join(library, "ufc-training-footage.mp4"), sport: "mma", stock: true, orientation: "landscape", title: "" },
  { ...owner, id: "library-ufc-training-vertical", file: path.join(library, "ufc-training-footage-1.mp4"), sport: "mma", stock: true, orientation: "portrait", title: "" },
  // General news: the background for any story nothing else covers.
  { ...owner, id: "library-newspaper", file: path.join(library, "news-paper-flipping.mp4"), sport: "*", stock: true, title: "" },
];

// The local files contain only the reviewed game-action ranges of the sources.
export const footageArchive = [
  {
    ...usGovernment,
    id: "archive-texas-tennessee-2026", file: path.join(directory, "texas-tennessee-2026.mp4"),
    sport: "football", teams: ["texas longhorns"],
    title: "Texas at Tennessee", date: "2026-09-26", creator: "The White House",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:President_Trump_Attends_Texas_v._TN_Football_Game.webm",
  },
  {
    ...usGovernment,
    id: "archive-michigan-state-gonzaga-2022", file: path.join(directory, "michigan-state-gonzaga-2022.mp4"),
    sport: "basketball", teams: ["michigan state spartans", "gonzaga bulldogs"],
    title: "Michigan State vs. Gonzaga", date: "2022-11-11", creator: "Ian Thomas / U.S. Navy",
    sourceUrl: "https://www.dvidshub.net/video/864280/abraham-lincoln-hosts-armed-forces-classic-carrier-edition",
    licenseUrl: "https://www.dvidshub.net/about/copyright",
  },
  {
    ...usGovernment,
    id: "archive-knicks-spurs-finals-2026", file: path.join(directory, "knicks-spurs-finals-2026.mp4"),
    sport: "basketball", teams: ["new york knicks", "san antonio spurs"], people: ["josh hart"],
    title: "Knicks vs. Spurs · NBA Finals Game 3", date: "2026-06-08", creator: "The White House",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:President_Trump_Attends_the_NBA_Finals_at_Madison_Square_Garden_(1440p_24fps_AV1-128kbit_AAC).webm",
  },
  {
    id: "archive-blue-jays-red-sox-2014", file: path.join(directory, "blue-jays-red-sox-2014.mp4"),
    sport: "baseball", teams: ["toronto blue jays", "boston red sox"],
    title: "Blue Jays vs. Red Sox", date: "2014-04-18", creator: "Elgaard",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:PitchBat.ogv",
    license: "CC BY-SA 3.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0/", previewOnly: true,
  },
];
