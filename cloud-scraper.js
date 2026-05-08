"use strict";

/**
 * Standalone cloud scraper — runs in GitHub Actions on a cron schedule.
 * Reads monitors.json, scrapes each active monitor, writes results to results/latest.json.
 * No Express, no SQLite — just JSON files.
 */
const fs = require("fs");
const path = require("path");
const AmazonScraper = require("./scraper");

const MONITORS_FILE = path.join(__dirname, "monitors.json");
const RESULTS_FILE = path.join(__dirname, "results", "latest.json");
const HISTORY_DIR = path.join(__dirname, "results", "history");

function loadMonitors() {
  if (!fs.existsSync(MONITORS_FILE)) return [];
  return JSON.parse(fs.readFileSync(MONITORS_FILE, "utf-8"));
}

function saveResults(results) {
  const dir = path.dirname(RESULTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });

  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-");
  const dateStr = now.toISOString().slice(0, 10);

  // Save latest
  const output = {
    generated_at: now.toISOString(),
    results,
  };
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(output, null, 2));

  // Save daily history
  const dayFile = path.join(HISTORY_DIR, `${dateStr}.json`);
  let dayData = [];
  if (fs.existsSync(dayFile)) {
    dayData = JSON.parse(fs.readFileSync(dayFile, "utf-8"));
  }
  dayData.push({ timestamp: now.toISOString(), results });
  fs.writeFileSync(dayFile, JSON.stringify(dayData, null, 2));

  console.log(`Saved ${results.length} results to ${RESULTS_FILE}`);
}

function getCurrentTimeInTz(timezone) {
  try {
    const now = new Date();
    return now.toLocaleString("en-US", { timeZone: timezone, hour12: false, hour: "2-digit", minute: "2-digit" });
  } catch {
    return null;
  }
}

async function main() {
  const monitors = loadMonitors();
  if (monitors.length === 0) {
    console.log("No monitors configured. Exiting.");
    return;
  }

  // Filter monitors that should run now (schedule_time matches current time in their timezone)
  const toRun = monitors.filter(m => {
    if (!m.schedule_time) return true; // no schedule = run every time
    const currentTime = getCurrentTimeInTz(m.timezone || "America/Los_Angeles");
    if (!currentTime) return true;
    // Allow a 5-minute window
    const [ch, cm] = currentTime.split(":").map(Number);
    const [sh, sm] = m.schedule_time.split(":").map(Number);
    const currentMins = ch * 60 + cm;
    const scheduleMins = sh * 60 + sm;
    return Math.abs(currentMins - scheduleMins) <= 5;
  });

  if (toRun.length === 0) {
    console.log("No monitors scheduled for this time. Skipping.");
    // Still record a "no run" to keep the file updated
    return;
  }

  console.log(`Running ${toRun.length} monitor(s)...`);

  const scraper = new AmazonScraper(true); // headless
  await scraper.start();

  const results = [];
  for (const m of toRun) {
    console.log(`  Scraping: ${m.asin} / ${m.keyword} (zip=${m.zip_code})`);
    try {
      const r = await scraper.searchRankings(m.keyword, m.asin, m.zip_code || "");
      results.push({
        asin: m.asin,
        keyword: m.keyword,
        zip_code: m.zip_code || "",
        product_name: m.product_name || "",
        owner: m.owner || "",
        organic_rank: r.organic_rank,
        ad_rank: r.ad_rank,
        total_results: r.total_results,
        error: r.error,
        timestamp: r.timestamp,
      });
      console.log(`    organic=#${r.organic_rank}, ad=#${r.ad_rank}`);
    } catch (err) {
      results.push({
        asin: m.asin,
        keyword: m.keyword,
        zip_code: m.zip_code || "",
        product_name: m.product_name || "",
        owner: m.owner || "",
        organic_rank: null,
        ad_rank: null,
        total_results: 0,
        error: err.message,
        timestamp: new Date().toISOString().replace("T", " ").slice(0, 19),
      });
      console.error(`    Error: ${err.message}`);
    }
  }

  await scraper.stop();
  saveResults(results);
  console.log("Done.");
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
