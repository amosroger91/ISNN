import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";

export async function saveJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(value));
  await rename(`${file}.tmp`, file);
}
export const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
