import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function saveJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(value));
  for (let attempt = 0; ; attempt += 1) {
    try { await rename(`${file}.tmp`, file); break; }
    catch (error) {
      // Windows scanners can briefly lock the destination during rapid story
      // edits. Retry the atomic replace while keeping the previous file intact.
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 5) throw error;
      await delay(Math.min(25 * 2 ** attempt, 200));
    }
  }
}
export const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
