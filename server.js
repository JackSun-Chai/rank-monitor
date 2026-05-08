"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");
const cron = require("node-cron");
const multer = require("multer");
const XLSX = require("xlsx");

const {
  initDb, saveResult, getHistory, getTrend,
  addMonitor, updateMonitor, getMonitors, toggleMonitor, deleteMonitor,
  bulkAddMonitors,
} = require("./database");

const AmazonScraper = require("./scraper");

const app = express();
const PORT = 5050;

app.use(express.json());
app.use("/static", express.static(path.join(__dirname, "static")));
app.use("/results", express.static(path.join(__dirname, "results")));
app.get("/monitors.json", (_req, res) => res.sendFile(MONITORS_JSON));

// ── Multer for Excel upload ────────────────────────────────────────────────

const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const upload = multer({
  dest: uploadDir,
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if ([".xlsx", ".xls", ".csv"].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only .xlsx, .xls, .csv files are allowed"));
    }
  },
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// ── Serve index ────────────────────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "templates", "index.html"));
});

const MONITORS_JSON = path.join(__dirname, "monitors.json");

function syncMonitorsToJson() {
  const monitors = getMonitors(false); // all, including inactive
  const data = monitors.map(m => ({
    asin: m.asin,
    keyword: m.keyword,
    zip_code: m.zip_code || "",
    product_name: m.product_name || "",
    owner: m.owner || "",
    label: m.label || "",
    schedule_time: m.schedule_time || null,
    timezone: m.timezone || "America/Los_Angeles",
  }));
  fs.writeFileSync(MONITORS_JSON, JSON.stringify(data, null, 2));
}

// ── Scraper singleton ──────────────────────────────────────────────────────

let scraper = null;

async function getScraper() {
  if (!scraper) {
    scraper = new AmazonScraper(true);
    await scraper.start();
    console.log("Playwright + Chromium (incognito) started.");
  }
  return scraper;
}

async function doSearch(keyword, asin, zipCode) {
  const s = await getScraper();
  return await s.searchRankings(keyword, asin, zipCode);
}

// ── Scheduler ──────────────────────────────────────────────────────────────

const scheduleMap = new Map();

function rebuildSchedules() {
  syncMonitorsToJson(); // keep monitors.json in sync for cloud scheduler
  for (const [, task] of scheduleMap) {
    task.stop();
  }
  scheduleMap.clear();

  const monitors = getMonitors(true);
  const byTime = new Map();

  for (const m of monitors) {
    if (!m.schedule_time) continue;
    if (!byTime.has(m.schedule_time)) {
      byTime.set(m.schedule_time, []);
    }
    byTime.get(m.schedule_time).push(m);
  }

  for (const [timeStr, items] of byTime) {
    const [hour, minute] = timeStr.split(":");
    if (!hour || !minute) continue;
    const cronExpr = `${parseInt(minute)} ${parseInt(hour)} * * *`;
    if (!cron.validate(cronExpr)) continue;

    // Group by time + timezone: items at the same HH:MM but different TZ need separate jobs
    const byTz = new Map();
    for (const m of items) {
      const tz = m.timezone || "America/Los_Angeles";
      if (!byTz.has(tz)) byTz.set(tz, []);
      byTz.get(tz).push(m);
    }

    for (const [tz, tzItems] of byTz) {
      const key = `${timeStr}|${tz}`;
      const task = cron.schedule(cronExpr, async () => {
        console.log(`[Scheduler] Running ${tzItems.length} monitor(s) at ${timeStr} (${tz})`);
        for (const m of tzItems) {
          try {
            const r = await doSearch(m.keyword, m.asin, m.zip_code);
            saveResult(r);
            console.log(`  ${m.asin} / ${m.keyword} → organic=${r.organic_rank}, ad=${r.ad_rank}`);
          } catch (err) {
            console.error(`  ${m.asin} / ${m.keyword} → error: ${err.message}`);
          }
        }
      }, { timezone: tz });

      scheduleMap.set(key, task);
      console.log(`[Scheduler] Scheduled ${tzItems.length} monitor(s) at ${timeStr} ${tz}`);
    }
  }
}

// ── API: Search ────────────────────────────────────────────────────────────

app.post("/api/search", async (req, res) => {
  const { keyword, asin, zip_code = "" } = req.body || {};
  if (!keyword || !asin) {
    return res.status(400).json({ error: "Keyword and ASIN are required" });
  }
  const result = await doSearch(keyword.trim(), asin.trim(), (zip_code || "").trim());
  saveResult(result);
  return res.json(result);
});

// ── API: History ───────────────────────────────────────────────────────────

app.get("/api/history", (req, res) => {
  const { keyword, asin, limit } = req.query;
  const rows = getHistory({
    keyword: keyword || undefined,
    asin: asin || undefined,
    limit: parseInt(limit) || 100,
  });
  return res.json(rows);
});

// ── API: Trend ─────────────────────────────────────────────────────────────

app.get("/api/trend", (req, res) => {
  const { keyword, asin, zip_code = "", days } = req.query;
  if (!keyword || !asin) {
    return res.status(400).json({ error: "keyword and asin required" });
  }
  const rows = getTrend(keyword, asin, zip_code, parseInt(days) || 30);
  return res.json(rows);
});

// ── API: Monitors CRUD ─────────────────────────────────────────────────────

app.get("/api/monitors", (req, res) => {
  const activeOnly = req.query.active_only !== "0";
  return res.json(getMonitors(activeOnly));
});

app.post("/api/monitors", (req, res) => {
  const { asin, keyword, zip_code, product_name, owner, label, schedule_time, timezone } = req.body || {};
  if (!asin || !keyword) {
    return res.status(400).json({ error: "ASIN and keyword required" });
  }
  const ok = addMonitor(
    asin.trim(), keyword.trim(),
    (zip_code || "").trim(),
    product_name || null,
    owner || null,
    label || null,
    schedule_time || null,
    timezone || "America/Los_Angeles"
  );
  if (ok) {
    rebuildSchedules();
    return res.json({ status: "added" });
  }
  return res.status(409).json({ status: "already_exists" });
});

app.patch("/api/monitors/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const updates = req.body || {};

  // Map frontend field names to DB column names
  const fieldMap = {
    asin: "asin",
    keyword: "keyword",
    zip_code: "zip_code",
    product_name: "product_name",
    owner: "owner",
    label: "label",
    schedule_time: "schedule_time",
    timezone: "timezone",
    active: "active",
    zipCode: "zip_code",
    scheduleTime: "schedule_time",
    productName: "product_name",
  };

  const dbUpdates = {};
  for (const [key, value] of Object.entries(updates)) {
    const dbKey = fieldMap[key] || key;
    dbUpdates[dbKey] = value;
  }

  updateMonitor(id, dbUpdates);
  rebuildSchedules();
  return res.json({ status: "updated" });
});

app.delete("/api/monitors/:id", (req, res) => {
  deleteMonitor(parseInt(req.params.id));
  rebuildSchedules();
  return res.json({ status: "deleted" });
});

// ── API: Excel import ──────────────────────────────────────────────────────

app.post("/api/monitors/import", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  try {
    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    // Normalize header keys (case-insensitive)
    const headerMap = {
      "asin": "asin", "ASIN": "asin",
      "keyword": "keyword", "Keyword": "keyword", "keywords": "keyword", "KEYWORD": "keyword",
      "zip": "zip_code", "zip code": "zip_code", "zipcode": "zip_code", "Zip Code": "zip_code", "ZIP": "zip_code", "邮编": "zip_code",
      "product name": "product_name", "Product Name": "product_name", "product": "product_name", "产品名称": "product_name",
      "owner": "owner", "Owner": "owner", "负责人": "owner",
      "label": "label", "Label": "label", "标签": "label", "备注": "label",
      "schedule": "schedule_time", "schedule time": "schedule_time", "scheduletime": "schedule_time", "Schedule": "schedule_time", "定时": "schedule_time",
      "timezone": "timezone", "Timezone": "timezone", "Time Zone": "timezone", "时区": "timezone",
    };

    const entries = [];
    for (const row of rows) {
      const entry = {};
      for (const [key, value] of Object.entries(row)) {
        const normalizedKey = key.trim().toLowerCase();
        const mapped = Object.entries(headerMap).find(
          ([h]) => h.toLowerCase() === normalizedKey
        );
        if (mapped) {
          const strVal = String(value).trim();
          entry[mapped[1]] = strVal || null;
        }
      }
      // Also try direct mapping (case-insensitive)
      if (!entry.asin) entry.asin = row["ASIN"] || row["asin"] || null;
      if (!entry.keyword) entry.keyword = row["Keyword"] || row["keyword"] || row["keywords"] || null;
      if (entry.asin && entry.keyword) {
        entries.push(entry);
      }
    }

    const result = bulkAddMonitors(entries);
    rebuildSchedules();

    // Clean up uploaded file
    fs.unlinkSync(req.file.path);

    return res.json({
      status: "imported",
      added: result.added,
      skipped: result.skipped,
      total: entries.length,
    });
  } catch (err) {
    // Clean up on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    return res.status(400).json({ error: `Parse error: ${err.message}` });
  }
});

// ── API: Download Excel template ────────────────────────────────────────────

app.get("/api/monitors/template", (_req, res) => {
  const template = [
    { ASIN: "B09XYZ1234", Keyword: "bluetooth speaker", "Zip Code": "10001", "Product Name": "蓝牙音箱", Owner: "张三", Label: "主推款", Schedule: "08:00", Timezone: "America/Los_Angeles" },
  ];
  const ws = XLSX.utils.json_to_sheet(template);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Monitors");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  res.setHeader("Content-Disposition", "attachment; filename=monitor_template.xlsx");
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  return res.send(Buffer.from(buf));
});

// ── API: Run all monitors ──────────────────────────────────────────────────

app.post("/api/monitors/run-all", async (req, res) => {
  const monitors = getMonitors(true);
  const results = [];

  for (const m of monitors) {
    const r = await doSearch(m.keyword, m.asin, m.zip_code);
    saveResult(r);
    results.push({
      keyword: m.keyword,
      asin: m.asin,
      organic_rank: r.organic_rank,
      ad_rank: r.ad_rank,
      error: r.error,
    });
  }

  return res.json(results);
});

// ── API: Schedule status ──────────────────────────────────────────────────

app.get("/api/schedules", (_req, res) => {
  const result = [];
  for (const [key, task] of scheduleMap) {
    const [time, tz] = key.split("|");
    result.push({ time, timezone: tz, running: !!task });
  }
  return res.json(result);
});

// ── Error handler (multer errors) ──────────────────────────────────────────

app.use((err, _req, res, _next) => {
  if (err.message?.includes("Only .xlsx")) {
    return res.status(400).json({ error: err.message });
  }
  console.error(err);
  return res.status(500).json({ error: "Internal error" });
});

// ── Start ──────────────────────────────────────────────────────────────────

(async () => {
  await initDb();
  console.log("Database initialized.");
  rebuildSchedules();

  app.listen(PORT, "127.0.0.1", () => {
    console.log(`Rank Monitor running at http://127.0.0.1:${PORT}`);
  });
})();
