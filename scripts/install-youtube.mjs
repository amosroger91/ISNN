import path from "node:path";
import { root } from "../server/config.mjs";
import { run } from "../server/process.mjs";

const python = process.env.SPORTS_PYTHON || (process.platform === "win32" ? "python" : "python3");
console.log(await run(python, ["-m", "pip", "install", "--upgrade", "--target", path.join(root, ".runtime", "youtube"), "yt-dlp[default]"], { timeout: 180_000 }));
