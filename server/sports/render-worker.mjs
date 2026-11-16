import { renderEpisode } from "./produce.mjs";

process.once("message", async ({ episode, directory }) => {
  let result;
  try {
    const metadata = await renderEpisode(episode, directory, (percent, message) => {
      process.send({ progress: { percent, message } });
    });
    result = { metadata };
  } catch (error) {
    result = { error: error.message };
  }
  process.send(result, () => process.disconnect());
});
