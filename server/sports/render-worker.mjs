import { renderEpisode } from "./produce.mjs";

const controller = new AbortController();
let started = false;
process.on("disconnect", () => controller.abort());
process.on("message", async ({ episode, directory, cancel }) => {
  if (cancel) { controller.abort(); return; }
  if (started) return;
  started = true;
  let result;
  try {
    const metadata = await renderEpisode(episode, directory, (percent, message) => {
      if (process.connected) process.send({ progress: { percent, message } });
    }, controller.signal);
    result = { metadata };
  } catch (error) {
    result = { error: error.message };
  }
  if (process.connected) process.send(result, () => process.disconnect());
});
