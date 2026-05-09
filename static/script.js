/* ── DOM refs ───────────────────────────────────────────── */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const searchForm    = $("#search-form");
const searchBtn     = $("#search-btn");
const searchStatus  = $("#search-status");
const resultPanel   = $("#result-panel");
const monitorForm   = $("#monitor-form");
const monitorTbody  = $("#monitor-tbody");
const monitorStatus = $("#monitor-status");
const runAllBtn     = $("#run-all-btn");
const importBtn     = $("#import-btn");
const importFile    = $("#import-file");
const historyTbody  = $("#history-tbody");
const trendChartCanvas = $("#trend-chart");
const trendAsin     = $("#trend-asin");
const trendDays     = $("#trend-days");
const trendKeyword  = $("#trend-keyword");
const editModal     = $("#edit-modal");
const editForm      = $("#edit-form");

let chartInstance = null;
let useLocalApi = true; // auto-detected on load

/* ── API helper: try local, fallback to static JSON ──────── */
async function apiFetch(path) {
  if (useLocalApi) {
    try {
      const res = await fetch(path);
      if (res.ok) return res;
    } catch {}
    // Local API unreachable — switch to file mode
    console.log("Local API not available, switching to file mode");
    useLocalApi = false;
  }
  // Fallback: try static file path
  return fetch(path.replace("/api/", "/").replace("/history", "/results/latest.json").replace("/monitors", "/monitors.json").replace("/trend", "/results/latest.json"));
}

/* ── Search ─────────────────────────────────────────────── */
searchForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const keyword = $("#keyword").value.trim();
  const asin    = $("#asin").value.trim();
  const zipCode = $("#zip-code").value.trim();

  if (!keyword || !asin) return;

  searchBtn.disabled = true;
  showStatus(searchStatus, "info", "正在使用无痕模式查询 Amazon 排名...");
  resultPanel.classList.add("hidden");

  try {
    const res = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword, asin, zip_code: zipCode }),
    });
    const data = await res.json();

    if (data.error) {
      showStatus(searchStatus, "error", `错误: ${data.error}`);
      $("#result-error").textContent = data.error;
      $("#result-error").classList.remove("hidden");
    } else {
      showStatus(searchStatus, "success", "查询完成!");
      $("#organic-rank").textContent = formatPosition(data.organic_page, data.organic_pos, data.organic_status);
      $("#organic-detail").textContent = data.organic_status === "found" ? `第${data.organic_page}页第${data.organic_pos}位` : "";
      $("#ad-rank").textContent = formatPosition(data.ad_page, data.ad_pos, data.ad_status);
      $("#ad-detail").textContent = data.ad_status === "found" ? `第${data.ad_page}页第${data.ad_pos}位` : "";
      $("#total-results").textContent = (data.total_results || 0).toLocaleString();
      $("#result-error").classList.add("hidden");
      resultPanel.classList.remove("hidden");
    }
  } catch (err) {
    showStatus(searchStatus, "error", `请求失败: ${err.message}`);
  } finally {
    searchBtn.disabled = false;
    loadHistory();
    loadMonitors();
  }
});

/* ── Monitor: Add ───────────────────────────────────────── */
monitorForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const asin        = $("#m-asin").value.trim();
  const keyword     = $("#m-keyword").value.trim();
  const zip         = $("#m-zip").value.trim();
  const productName = $("#m-product-name").value.trim();
  const owner       = $("#m-owner").value.trim();
  const label       = $("#m-label").value.trim();
  const schedule    = $("#m-schedule").value.trim();
  const timezone    = $("#m-timezone").value;

  if (!asin || !keyword) return;

  try {
    const res = await fetch("/api/monitors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        asin, keyword, zip_code: zip,
        product_name: productName || null,
        owner: owner || null,
        label: label || null,
        schedule_time: schedule || null,
        timezone: timezone || "America/Los_Angeles",
      }),
    });
    const data = await res.json();
    if (res.ok) {
      showStatus(monitorStatus, "success", schedule ? `已添加监控，每日 ${schedule} 自动抓取` : "已添加监控");
      monitorForm.reset();
      loadMonitors();
    } else {
      showStatus(monitorStatus, "error", data.status || "添加失败");
    }
  } catch (err) {
    showStatus(monitorStatus, "error", err.message);
  }
});

/* ── Monitor: Import Excel ──────────────────────────────── */
importBtn.addEventListener("click", () => importFile.click());

importFile.addEventListener("change", async () => {
  const file = importFile.files[0];
  if (!file) return;

  showStatus(monitorStatus, "info", `正在导入 ${file.name} ...`);

  try {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/monitors/import", {
      method: "POST",
      body: formData,
    });
    const data = await res.json();
    if (res.ok && data.status === "imported") {
      showStatus(monitorStatus, "success", `导入完成: 新增 ${data.added} 条, 跳过 ${data.skipped} 条`);
      loadMonitors();
    } else {
      showStatus(monitorStatus, "error", data.error || "导入失败");
    }
  } catch (err) {
    showStatus(monitorStatus, "error", err.message);
  } finally {
    importFile.value = "";
  }
});

/* ── Monitor: Run All ───────────────────────────────────── */
runAllBtn.addEventListener("click", async () => {
  runAllBtn.disabled = true;
  showStatus(monitorStatus, "info", "正在批量查询所有监控项...");
  try {
    const res = await fetch("/api/monitors/run-all", { method: "POST" });
    const data = await res.json();
    showStatus(monitorStatus, "success", `已完成 ${data.length} 项查询`);
    loadMonitors();
    loadHistory();
  } catch (err) {
    showStatus(monitorStatus, "error", err.message);
  } finally {
    runAllBtn.disabled = false;
  }
});

/* ── Monitor: Render Table ──────────────────────────────── */
async function loadMonitors() {
  try {
    const res = await fetch("/api/monitors");
    const monitors = await res.json();
    monitorTbody.innerHTML = monitors.length === 0
      ? `<tr><td colspan="13" style="text-align:center;color:var(--text-muted);">暂无监控项</td></tr>`
      : monitors.map(m => `
        <tr data-id="${m.id}">
          <td><code>${esc(m.asin)}</code></td>
          <td>${esc(m.keyword)}</td>
          <td>${m.zip_code || "--"}</td>
          <td>${esc(m.product_name || "--")}</td>
          <td>${esc(m.owner || "--")}</td>
          <td class="schedule-cell" onclick="editSchedule(${m.id}, '${esc(m.keyword)}')" title="点击修改定时">
            ${m.schedule_time ? `<span class="schedule-badge">${m.schedule_time}</span>` : '<span class="schedule-off">--</span>'}
          </td>
          <td><span class="tz-badge">${tzLabel(m.timezone)}</span></td>
          <td class="rank-cell" id="org-${m.id}">--</td>
          <td class="rank-cell" id="ad-${m.id}">--</td>
          <td class="rank-cell" id="ts-${m.id}">--</td>
          <td>
            <button class="btn btn-sm btn-outline" onclick="openEdit(${m.id})">编辑</button>
            <button class="btn btn-sm btn-outline" onclick="runSingleMonitor(${m.id},'${esc(m.asin)}','${esc(m.keyword)}','${esc(m.zip_code)}')">查询</button>
            <button class="btn btn-sm btn-danger" onclick="removeMonitor(${m.id})">删除</button>
          </td>
        </tr>`).join("");

    // Fill latest ranks
    for (const m of monitors) {
      const hRes = await fetch(`/api/history?asin=${m.asin}&keyword=${encodeURIComponent(m.keyword)}&limit=1`);
      const hData = await hRes.json();
      if (hData.length > 0) {
        const r = hData[0];
        const orgEl = document.getElementById(`org-${m.id}`);
        const adEl  = document.getElementById(`ad-${m.id}`);
        const tsEl  = document.getElementById(`ts-${m.id}`);
        if (orgEl) orgEl.innerHTML = formatPositionCell(r.organic_page, r.organic_pos, r.organic_status);
        if (adEl)  adEl.innerHTML  = formatPositionCell(r.ad_page, r.ad_pos, r.ad_status);
        if (tsEl)  tsEl.textContent  = r.created_at?.slice(0, 16) ?? "--";
      }
    }

    populateTrendSelectors(monitors);
  } catch (err) {
    console.error("loadMonitors error", err);
  }
}

/* ── Monitor: Edit Modal ────────────────────────────────── */
async function openEdit(id) {
  const res = await fetch("/api/monitors?active_only=0");
  const monitors = await res.json();
  const m = monitors.find(x => x.id === id);
  if (!m) return;

  $("#edit-id").value = m.id;
  $("#edit-asin").value = m.asin;
  $("#edit-keyword").value = m.keyword;
  $("#edit-zip").value = m.zip_code || "";
  $("#edit-product-name").value = m.product_name || "";
  $("#edit-owner").value = m.owner || "";
  $("#edit-label").value = m.label || "";
  $("#edit-schedule").value = m.schedule_time || "";
  $("#edit-timezone").value = m.timezone || "America/Los_Angeles";

  editModal.classList.remove("hidden");
}

function closeModal() {
  editModal.classList.add("hidden");
}

$("#modal-close").addEventListener("click", closeModal);
$("#modal-cancel").addEventListener("click", closeModal);
editModal.addEventListener("click", (e) => {
  if (e.target === editModal) closeModal();
});

editForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $("#edit-id").value;

  const body = {
    asin: $("#edit-asin").value.trim(),
    keyword: $("#edit-keyword").value.trim(),
    zip_code: $("#edit-zip").value.trim(),
    product_name: $("#edit-product-name").value.trim() || null,
    owner: $("#edit-owner").value.trim() || null,
    label: $("#edit-label").value.trim() || null,
    schedule_time: $("#edit-schedule").value.trim() || null,
    timezone: $("#edit-timezone").value || "America/Los_Angeles",
  };

  try {
    const res = await fetch(`/api/monitors/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      showStatus(monitorStatus, "success", "已保存");
      closeModal();
      loadMonitors();
    } else {
      const data = await res.json();
      showStatus(monitorStatus, "error", data.error || "保存失败");
    }
  } catch (err) {
    showStatus(monitorStatus, "error", err.message);
  }
});

/* ── Monitor: Schedule quick edit ───────────────────────── */
async function editSchedule(id, keyword) {
  const newTime = prompt(
    `设置 "${keyword}" 的定时抓取时间:\n\n格式: HH:MM (24小时制)\n例如: 08:00, 14:30, 22:00\n留空则取消定时`,
    ""
  );
  if (newTime === null) return;

  const timeVal = newTime.trim();
  if (timeVal && !/^\d{2}:\d{2}$/.test(timeVal)) {
    alert("格式错误，请输入 HH:MM（例如 08:00）");
    return;
  }

  try {
    await fetch(`/api/monitors/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schedule_time: timeVal || null }),
    });
    loadMonitors();
  } catch (err) {
    console.error("editSchedule error", err);
  }
}

/* ── Monitor: Single Run ────────────────────────────────── */
async function runSingleMonitor(id, asin, keyword, zip) {
  showStatus(monitorStatus, "info", `正在查询 ${keyword}...`);
  try {
    await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword, asin, zip_code: zip }),
    });
    showStatus(monitorStatus, "success", "查询完成");
    loadMonitors();
    loadHistory();
  } catch (err) {
    showStatus(monitorStatus, "error", err.message);
  }
}

/* ── Monitor: Delete ────────────────────────────────────── */
async function removeMonitor(id) {
  if (!confirm("确定删除此监控项？")) return;
  try {
    await fetch(`/api/monitors/${id}`, { method: "DELETE" });
    loadMonitors();
  } catch (err) {
    console.error(err);
  }
}

/* ── Cloud mode loader ──────────────────────────────────── */
async function loadCloudData() {
  try {
    const [monRes, resRes] = await Promise.all([
      fetch("/monitors.json"),
      fetch("/results/latest.json"),
    ]);

    let monitors = [];
    let results = [];

    if (monRes.ok) {
      const data = await monRes.json();
      monitors = Array.isArray(data) ? data : [];
    }

    if (resRes.ok) {
      const data = await resRes.json();
      results = data.results || [];
    }

    // Build a map: "asin|keyword" -> latest result
    const resultMap = {};
    for (const r of results) {
      const key = `${r.asin}|${r.keyword}`;
      resultMap[key] = r;
    }

    monitorTbody.innerHTML = monitors.length === 0
      ? `<tr><td colspan="13" style="text-align:center;color:var(--text-muted);">暂无监控项 (从 monitors.json 读取)</td></tr>`
      : monitors.map((m, i) => {
          const key = `${m.asin}|${m.keyword}`;
          const r = resultMap[key] || {};
          const id = i + 1;
          return `
        <tr data-id="${id}">
          <td><code>${esc(m.asin)}</code></td>
          <td>${esc(m.keyword)}</td>
          <td>${m.zip_code || "--"}</td>
          <td>${esc(m.product_name || "--")}</td>
          <td>${esc(m.owner || "--")}</td>
          <td>${m.schedule_time ? `<span class="schedule-badge">${m.schedule_time}</span>` : '<span class="schedule-off">--</span>'}</td>
          <td><span class="tz-badge">${tzLabel(m.timezone)}</span></td>
          <td>${formatPositionCell(r.organic_page, r.organic_pos, r.organic_status)}</td>
          <td>${formatPositionCell(r.ad_page, r.ad_pos, r.ad_status)}</td>
          <td>${r.timestamp ? r.timestamp.slice(0, 16) : "--"}</td>
          <td><span class="rank-null" style="font-size:0.8rem">云端模式</span></td>
        </tr>`;
        }).join("");

    // Also populate trend selectors
    populateTrendSelectors(monitors.map((m, i) => ({ ...m, id: i + 1 })));

    // Render history from results
    historyTbody.innerHTML = results.length === 0
      ? `<tr><td colspan="8" style="text-align:center;color:var(--text-muted);">暂无云端结果</td></tr>`
      : results.map(r => `
        <tr>
          <td>${r.timestamp?.slice(0, 16) ?? ""}</td>
          <td>${esc(r.keyword)}</td>
          <td><code>${esc(r.asin)}</code></td>
          <td>${r.zip_code || "--"}</td>
          <td>${formatPositionCell(r.organic_page, r.organic_pos, r.organic_status)}</td>
          <td>${formatPositionCell(r.ad_page, r.ad_pos, r.ad_status)}</td>
          <td>${r.total_results?.toLocaleString() ?? "--"}</td>
          <td>${r.error ? `<span style="color:var(--danger)">失败</span>` : "成功"}</td>
        </tr>`).join("");

  } catch (err) {
    console.error("loadCloudData error", err);
  }
}

/* ── History ────────────────────────────────────────────── */
$("#refresh-history").addEventListener("click", loadHistory);

async function loadHistory() {
  try {
    const kw = $("#h-keyword").value.trim();
    const asin = $("#h-asin").value.trim();
    let url = "/api/history?limit=50";
    if (kw) url += `&keyword=${encodeURIComponent(kw)}`;
    if (asin) url += `&asin=${encodeURIComponent(asin)}`;

    const res = await fetch(url);
    const rows = await res.json();

    historyTbody.innerHTML = rows.length === 0
      ? `<tr><td colspan="8" style="text-align:center;color:var(--text-muted);">暂无查询记录</td></tr>`
      : rows.map(r => `
        <tr>
          <td>${r.created_at?.slice(0, 16) ?? ""}</td>
          <td>${esc(r.keyword)}</td>
          <td><code>${esc(r.asin)}</code></td>
          <td>${r.zip_code || "--"}</td>
          <td>${formatPositionCell(r.organic_page, r.organic_pos, r.organic_status)}</td>
          <td>${formatPositionCell(r.ad_page, r.ad_pos, r.ad_status)}</td>
          <td>${r.total_results?.toLocaleString() ?? "--"}</td>
          <td>${r.error ? `<span style="color:var(--danger)">失败</span>` : "成功"}</td>
        </tr>`).join("");
  } catch (err) {
    console.error("loadHistory error", err);
  }
}

/* ── Trend Chart ────────────────────────────────────────── */
trendDays.addEventListener("change", updateTrendChart);
trendAsin.addEventListener("change", () => {
  const opt = trendAsin.selectedOptions[0];
  if (opt) trendKeyword.textContent = opt.dataset.keyword || "";
  updateTrendChart();
});

function populateTrendSelectors(monitors) {
  const current = trendAsin.value;
  trendAsin.innerHTML = monitors.map(m =>
    `<option value="${esc(m.asin)}" data-keyword="${esc(m.keyword)}" data-zip="${esc(m.zip_code)}">${esc(m.asin)} — ${esc(m.keyword)}</option>`
  ).join("");
  if (current) {
    const match = [...trendAsin.options].find(o => o.value === current);
    if (match) trendAsin.value = current;
  }
  if (trendAsin.selectedOptions[0]) {
    trendKeyword.textContent = trendAsin.selectedOptions[0].dataset.keyword || "";
  }
}

async function updateTrendChart() {
  const asin = trendAsin.value;
  const days = trendDays.value;
  if (!asin) return;

  const opt = trendAsin.selectedOptions[0];
  const keyword = opt?.dataset.keyword || "";
  const zip = opt?.dataset.zip || "";

  try {
    const res = await fetch(
      `/api/trend?asin=${asin}&keyword=${encodeURIComponent(keyword)}&zip_code=${zip}&days=${days}`
    );
    const data = await res.json();

    const labels = data.map(d => d.created_at?.slice(5, 16) ?? "");
    // Compute approximate global rank for charting: (page-1)*20 + position
    const organicData = data.map(d => (d.organic_page != null && d.organic_pos != null) ? (d.organic_page - 1) * 20 + d.organic_pos : null);
    const adData = data.map(d => (d.ad_page != null && d.ad_pos != null) ? (d.ad_page - 1) * 20 + d.ad_pos : null);

    if (chartInstance) chartInstance.destroy();

    const datasets = [];
    if (organicData.some(v => v !== null)) {
      datasets.push({
        label: "自然排名 (Organic)",
        data: organicData,
        borderColor: "#2563eb",
        backgroundColor: "rgba(37,99,235,0.08)",
        fill: true,
        tension: 0.3,
        pointRadius: 3,
        pointHoverRadius: 6,
        yAxisID: "y",
      });
    }
    if (adData.some(v => v !== null)) {
      datasets.push({
        label: "广告排名 (Sponsored)",
        data: adData,
        borderColor: "#f59e0b",
        backgroundColor: "rgba(245,158,11,0.08)",
        fill: true,
        tension: 0.3,
        pointRadius: 3,
        pointHoverRadius: 6,
        yAxisID: "y",
      });
    }

    chartInstance = new Chart(trendChartCanvas, {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: "index" },
        scales: {
          y: {
            reverse: true,
            title: { display: true, text: "排名 (越小越靠前)" },
            min: 1,
            ticks: { stepSize: 1 },
          },
          x: { title: { display: true, text: "时间" } },
        },
        plugins: {
          legend: { position: "bottom" },
          tooltip: {
            callbacks: {
              label: (ctx) => ctx.raw ? `≈第 ${ctx.raw} 位` : "未找到",
            },
          },
        },
      },
    });
  } catch (err) {
    console.error("updateTrendChart error", err);
  }
}

/* ── Helpers ────────────────────────────────────────────── */
function showStatus(el, type, msg) {
  el.textContent = msg;
  el.className = `status ${type}`;
  el.classList.remove("hidden");
}

function rankCell(val) {
  if (val == null) return `<span class="rank-null">--</span>`;
  return `<span class="rank-hit">#${val}</span>`;
}

function formatPosition(page, pos, status) {
  if (status === "found" && page != null && pos != null) return `第${page}页第${pos}位`;
  if (status === "not_loaded") return "未显示";
  return "未找到";
}

function formatPositionCell(page, pos, status) {
  if (status === "found" && page != null && pos != null) return `<span class="rank-hit">第${page}页第${pos}位</span>`;
  if (status === "not_loaded") return `<span class="rank-null">未显示</span>`;
  return `<span class="rank-null">未找到</span>`;
}

function statusLabel(status) {
  if (status === "not_loaded") return "未显示";
  if (status === "not_found") return "未找到";
  return "";
}

function tzLabel(tz) {
  const map = {
    "America/Los_Angeles": "PT",
    "America/Denver": "MT",
    "America/Chicago": "CT",
    "America/New_York": "ET",
    "Asia/Shanghai": "北京",
    "Asia/Tokyo": "东京",
    "Europe/London": "伦敦",
  };
  return map[tz] || tz || "PT";
}

function esc(s) {
  if (!s) return "";
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

/* ── Init ───────────────────────────────────────────────── */
(async function init() {
  // Auto-detect: local API or cloud (GitHub Pages) mode
  try {
    const test = await fetch("/api/monitors");
    if (test.ok) {
      useLocalApi = true;
      console.log("Running in local mode (API)");
    } else {
      useLocalApi = false;
      console.log("Running in cloud mode (static files)");
    }
  } catch {
    useLocalApi = false;
    console.log("Running in cloud mode (static files)");
  }

  if (useLocalApi) {
    loadMonitors();
    loadHistory();
  } else {
    loadCloudData();
  }
})();
