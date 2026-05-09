"use strict";

const initSqlJs = require("sql.js");
const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "rankings.db");

let db = null;
let SQL = null;

async function initDb() {
  SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  db.run("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL,
      asin TEXT NOT NULL,
      zip_code TEXT NOT NULL DEFAULT '',
      organic_page INTEGER,
      organic_pos INTEGER,
      organic_status TEXT DEFAULT 'not_found',
      ad_page INTEGER,
      ad_pos INTEGER,
      ad_status TEXT DEFAULT 'not_found',
      total_results INTEGER DEFAULT 0,
      error TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_searches_keyword_asin
      ON searches(keyword, asin);

    CREATE TABLE IF NOT EXISTS monitored_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asin TEXT NOT NULL,
      keyword TEXT NOT NULL,
      zip_code TEXT NOT NULL DEFAULT '',
      product_name TEXT DEFAULT NULL,
      owner TEXT DEFAULT NULL,
      label TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      schedule_time TEXT DEFAULT NULL,
      timezone TEXT DEFAULT 'America/Los_Angeles',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(asin, keyword, zip_code)
    );
  `);
  // Migrations for existing databases
  migrateColumn("monitored_products", "schedule_time", "TEXT DEFAULT NULL");
  migrateColumn("monitored_products", "product_name", "TEXT DEFAULT NULL");
  migrateColumn("monitored_products", "owner", "TEXT DEFAULT NULL");
  migrateColumn("monitored_products", "timezone", "TEXT DEFAULT 'America/Los_Angeles'");
  save();
}

function migrateColumn(table, column, definition) {
  const cols = dbAll(`PRAGMA table_info(${table})`);
  if (!cols.some(c => c.name === column)) {
    dbRun(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function save() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  }
}

function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function dbRun(sql, params = []) {
  db.run(sql, params);
  save();
}

function saveResult({ keyword, asin, zip_code, organic_page, organic_pos, organic_status, ad_page, ad_pos, ad_status, total_results, error, source = "manual" }) {
  dbRun(
    `INSERT INTO searches (keyword, asin, zip_code, organic_page, organic_pos, organic_status,
                           ad_page, ad_pos, ad_status, total_results, error, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [keyword, asin, zip_code,
     organic_page ?? null, organic_pos ?? null, organic_status ?? "not_found",
     ad_page ?? null, ad_pos ?? null, ad_status ?? "not_found",
     total_results ?? 0, error ?? null, source]
  );
}

function getHistory({ keyword, asin, limit = 100 } = {}) {
  let sql = "SELECT * FROM searches WHERE 1=1";
  const params = [];
  if (keyword) { sql += " AND keyword LIKE ?"; params.push(`%${keyword}%`); }
  if (asin)    { sql += " AND asin = ?"; params.push(asin); }
  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);
  return dbAll(sql, params);
}

function getTrend(keyword, asin, zip_code = "", days = 30) {
  return dbAll(
    `SELECT created_at, organic_page, organic_pos, ad_page, ad_pos, ad_status
     FROM searches
     WHERE keyword = ? AND asin = ? AND zip_code = ?
       AND source = 'monitored'
       AND created_at >= datetime('now','localtime','-' || ? || ' days')
     ORDER BY created_at ASC`,
    [keyword, asin, zip_code, days]
  );
}

function getLatestMonitorResult(asin, keyword) {
  const rows = dbAll(
    `SELECT organic_page, organic_pos, ad_page, ad_pos, ad_status, created_at
     FROM searches
     WHERE asin = ? AND keyword = ? AND source = 'monitored'
     ORDER BY created_at DESC LIMIT 1`,
    [asin, keyword]
  );
  return rows[0] || null;
}

function addMonitor(asin, keyword, zip_code = "", product_name = null, owner = null, label = null, schedule_time = null, timezone = "America/Los_Angeles") {
  try {
    dbRun(
      `INSERT OR IGNORE INTO monitored_products
       (asin, keyword, zip_code, product_name, owner, label, schedule_time, timezone)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [asin, keyword, zip_code, product_name, owner, label, schedule_time, timezone]
    );
    return true;
  } catch { return false; }
}

function updateMonitor(id, updates) {
  const allowed = ["asin", "keyword", "zip_code", "product_name", "owner", "label", "schedule_time", "timezone", "active"];
  const setClauses = [];
  const params = [];
  for (const key of allowed) {
    if (key in updates) {
      setClauses.push(`${key} = ?`);
      params.push(updates[key]);
    }
  }
  if (setClauses.length === 0) return;
  params.push(id);
  dbRun(`UPDATE monitored_products SET ${setClauses.join(", ")} WHERE id = ?`, params);
}

function getMonitors(activeOnly = true) {
  let sql = "SELECT * FROM monitored_products";
  if (activeOnly) sql += " WHERE active = 1";
  sql += " ORDER BY created_at DESC";
  return dbAll(sql);
}

function toggleMonitor(id, active) {
  dbRun("UPDATE monitored_products SET active = ? WHERE id = ?", [active, id]);
}

function deleteMonitor(id) {
  dbRun("DELETE FROM monitored_products WHERE id = ?", [id]);
}

function bulkAddMonitors(entries) {
  let added = 0;
  let skipped = 0;
  for (const e of entries) {
    if (!e.asin || !e.keyword) { skipped++; continue; }
    try {
      dbRun(
        `INSERT OR IGNORE INTO monitored_products
         (asin, keyword, zip_code, product_name, owner, label, schedule_time, timezone)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [e.asin, e.keyword, e.zip_code || "", e.product_name || null, e.owner || null, e.label || null, e.schedule_time || null, e.timezone || "America/Los_Angeles"]
      );
      added++;
    } catch { skipped++; }
  }
  return { added, skipped };
}

module.exports = {
  initDb, saveResult, getHistory, getTrend, getLatestMonitorResult,
  addMonitor, updateMonitor, getMonitors, toggleMonitor, deleteMonitor,
  bulkAddMonitors,
};
