import { parentPort } from "node:worker_threads";
import { loadImage } from "../canvas.mjs";
import { renderBroadcast } from "./broadcast.mjs";
import { loadPlate } from "./produce.mjs";

// Draws one Short on its own thread so several Shorts render at once. Images
// can't cross threads, so plates and photos are loaded again from their files.
const controller = new AbortController();

parentPort.on("message", async (message) => {
  if (message.cancel) {
    controller.abort(new Error("Cancelled."));
    return;
  }
  try {
    const { spec, motion } = message;
    for (const story of spec.stories || []) {
      story.plate = story.plate ? await loadPlate(story.plate) : null;
      story.photos = await Promise.all((story.photos || []).map(async (photo) => (
        photo.file ? { ...photo, image: await loadImage(photo.file).catch(() => null) } : photo
      )));
    }
    spec.photos = spec.stories.flatMap((story) => story.photos);
    const result = await renderBroadcast({
      ...motion, spec, signal: controller.signal,
      report: (fraction) => parentPort.postMessage({ progress: fraction }),
    });
    parentPort.postMessage({ result });
  } catch (error) {
    parentPort.postMessage({ error: error.message || String(error) });
  }
});
