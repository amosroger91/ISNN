import "dotenv/config";

const port = Number(process.env.PORT || 4319);
const url = `http://127.0.0.1:${port}/api/sports/cron`;
try {
  const response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
} catch (error) {
  console.error(`Overtime Desk cron could not reach ${url}: ${error.message}`);
  process.exitCode = 1;
}
