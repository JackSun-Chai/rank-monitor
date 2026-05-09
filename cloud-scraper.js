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

  const scraper = new AmazonScraper(true);
  await scraper.start();

  // Batch by keyword for efficiency — same as server.js batchRunMonitors
  const byKeyword = new Map();
  for (const m of toRun) {
    if (!byKeyword.has(m.keyword)) byKeyword.set(m.keyword, []);
    byKeyword.get(m.keyword).push(m);
  }

  const results = [];
  for (const [keyword, items] of byKeyword) {
    const asins = items.map(m => m.asin);
    const zip = items[0].zip_code || "";
    console.log(`  Batch: "${keyword}" → ${asins.length} ASIN(s)`);
    try {
      const resultMap = await scraper.batchSearchRankings(keyword, asins, zip);
      for (const m of items) {
        const r = resultMap[m.asin];
        if (r) {
          results.push({
            asin: m.asin,
            keyword: m.keyword,
            zip_code: m.zip_code || "",
            product_name: m.product_name || "",
            owner: m.owner || "",
            organic_page: r.organic_page,
            organic_pos: r.organic_pos,
            organic_status: r.organic_status,
            ad_page: r.ad_page,
            ad_pos: r.ad_pos,
            ad_status: r.ad_status,
            total_results: r.total_results,
            error: r.error,
            timestamp: r.timestamp,
          });
          console.log(`    ${m.asin}: organic=${r.organic_status === "found" ? `第${r.organic_page}页第${r.organic_pos}位` : r.organic_status}, ad=${r.ad_status === "found" ? `第${r.ad_page}页第${r.ad_pos}位` : r.ad_status}`);
        }
      }
    } catch (err) {
      for (const m of items) {
        results.push({
          asin: m.asin,
          keyword: m.keyword,
          zip_code: m.zip_code || "",
          product_name: m.product_name || "",
          owner: m.owner || "",
          organic_page: null, organic_pos: null, organic_status: "not_found",
          ad_page: null, ad_pos: null, ad_status: "not_found",
          total_results: 0,
          error: err.message,
          timestamp: new Date().toISOString().replace("T", " ").slice(0, 19),
        });
      }
      console.error(`    Batch error for "${keyword}": ${err.message}`);
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
