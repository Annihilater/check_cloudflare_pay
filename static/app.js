(() => {
  const $ = (id) => document.getElementById(id);

  const els = {
    lengthGroup: $("lengthGroup"),
    customLength: $("customLength"),
    charsetGroup: $("charsetGroup"),
    charset: $("charset"),
    concurrency: $("concurrency"),
    delayMs: $("delayMs"),
    prefix: $("prefix"),
    suffix: $("suffix"),
    startIndex: $("startIndex"),
    endIndex: $("endIndex"),
    estimate: $("estimate"),
    btnStart: $("btnStart"),
    btnStop: $("btnStop"),
    btnCheck: $("btnCheck"),
    singleTag: $("singleTag"),
    singleResult: $("singleResult"),
    statusPill: $("statusPill"),
    statusText: $("statusText"),
    progressFill: $("progressFill"),
    progressPct: $("progressPct"),
    progressCount: $("progressCount"),
    statAvailable: $("statAvailable"),
    statTaken: $("statTaken"),
    statErrors: $("statErrors"),
    statRate: $("statRate"),
    statElapsed: $("statElapsed"),
    statEta: $("statEta"),
    currentTag: $("currentTag"),
    results: $("results"),
    resultsBadge: $("resultsBadge"),
    btnExport: $("btnExport"),
    btnExportTxt: $("btnExportTxt"),
    btnClear: $("btnClear"),
    log: $("log"),
    btnClearLog: $("btnClearLog"),
  };

  /** 页面上最多渲染多少个 chip，避免上万 DOM 卡死 */
  const MAX_VISIBLE_CHIPS = 200;
  /** 日志里最多连续打印 found 的条数/秒 */
  const FOUND_LOG_EVERY = 50;

  let selectedLength = 3;
  /** @type {string[]} 全量可用 tag（导出用，不全部渲染） */
  let availableTags = [];
  /** @type {Set<string>} */
  let availableSet = new Set();
  let eventSource = null;
  let isRunning = false;
  let foundSinceLog = 0;
  let lastFoundLogAt = 0;

  // 节流：进度 / chip 渲染
  let pendingProgress = null;
  let progressRaf = 0;
  let pendingChips = [];
  let chipFlushTimer = 0;

  const charsetSize = {
    digits: 10,
    letters: 26,
    alphanumeric: 36,
  };

  function formatNumber(n) {
    return new Intl.NumberFormat("zh-CN").format(n);
  }

  function formatDuration(secs) {
    if (secs == null || !Number.isFinite(secs)) return "—";
    secs = Math.max(0, Math.round(secs));
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function powBig(base, exp) {
    let r = 1n;
    let b = BigInt(base);
    let e = BigInt(exp);
    while (e > 0n) {
      if (e & 1n) r *= b;
      b *= b;
      e >>= 1n;
    }
    return r;
  }

  function getLength() {
    if (selectedLength === "custom") {
      const v = parseInt(els.customLength.value, 10);
      return Number.isFinite(v) ? v : 3;
    }
    return selectedLength;
  }

  function formatComboCount(n) {
    if (n > 999_999_999n) return formatNumber(999_999_999) + "+";
    return formatNumber(Number(n));
  }

  function updateCharsetCards() {
    const len = getLength();
    els.charsetGroup.querySelectorAll(".charset-card").forEach((card) => {
      const size = parseInt(card.dataset.size, 10) || 36;
      const total = powBig(size, len);
      const el = card.querySelector("[data-combos]");
      if (el) {
        el.textContent = `${formatComboCount(total)} 组合`;
        el.title = `${size}^${len} = ${total.toString()}`;
      }
    });
  }

  function selectCharset(value) {
    els.charset.value = value;
    els.charsetGroup.querySelectorAll(".charset-card").forEach((card) => {
      const active = card.dataset.charset === value;
      card.classList.toggle("active", active);
      card.setAttribute("aria-checked", active ? "true" : "false");
    });
    updateEstimate();
  }

  function updateEstimate() {
    const len = getLength();
    const size = charsetSize[els.charset.value] || 36;
    const total = powBig(size, len);
    const start = BigInt(Math.max(0, parseInt(els.startIndex.value || "0", 10) || 0));
    const endRaw = els.endIndex.value.trim();
    const end = endRaw === "" ? total : BigInt(Math.max(0, parseInt(endRaw, 10) || 0));
    const range = end > start ? end - start : 0n;
    const rangeClamped = range > total ? total : range;

    const concurrency = Math.max(1, parseInt(els.concurrency.value, 10) || 1);
    const estSecs =
      rangeClamped === 0n ? 0 : Number(rangeClamped) / concurrency;

    updateCharsetCards();

    els.estimate.innerHTML = `预计组合数：<strong>${formatComboCount(rangeClamped)}</strong>
      · 字符集 ${size}<sup>${len}</sup> = ${formatComboCount(total)}
      · 粗估耗时（并发 ${concurrency}，~1s/请求）：<strong>${formatDuration(estSecs)}</strong>`;

    if (concurrency > 30) {
      els.estimate.innerHTML +=
        `<br><span style="color:#fbbf24">⚠ 并发 &gt; 30 容易把页面/目标站打满，建议 10–20。</span>`;
    }
    if (len >= 5 && els.charset.value === "alphanumeric") {
      els.estimate.innerHTML +=
        `<br><span style="color:#fbbf24">⚠ 5 位字母数字约 6046 万组合，全量扫描极慢，建议加前缀/后缀或限制索引范围。</span>`;
    }
  }

  function setStatus(status) {
    isRunning = status === "running";
    els.statusPill.classList.remove("running", "stopped", "completed", "error");
    const map = {
      idle: "空闲",
      running: "扫描中",
      stopped: "已停止",
      completed: "已完成",
      error: "错误",
    };
    els.statusText.textContent = map[status] || status;
    if (status && status !== "idle") {
      els.statusPill.classList.add(status);
    }
    els.btnStart.disabled = isRunning;
    els.btnStop.disabled = !isRunning;
  }

  function applyProgress(p) {
    const total = p.total || 0;
    const checked = p.checked || 0;
    const pct = total > 0 ? Math.min(100, (checked / total) * 100) : 0;
    els.progressFill.style.width = `${pct.toFixed(2)}%`;
    els.progressPct.textContent = `${pct.toFixed(1)}%`;
    els.progressCount.textContent = `${formatNumber(checked)} / ${formatNumber(total)}`;
    els.statAvailable.textContent = formatNumber(p.available || 0);
    els.statTaken.textContent = formatNumber(p.taken || 0);
    els.statErrors.textContent = formatNumber(p.errors || 0);
    els.statRate.textContent = `${(p.rate_per_sec || 0).toFixed(2)}/s`;
    els.statElapsed.textContent = formatDuration(p.elapsed_secs || 0);
    els.statEta.textContent = formatDuration(p.eta_secs);
    if (p.current) els.currentTag.textContent = p.current;
  }

  function updateProgress(p) {
    pendingProgress = p;
    if (progressRaf) return;
    progressRaf = requestAnimationFrame(() => {
      progressRaf = 0;
      if (pendingProgress) {
        applyProgress(pendingProgress);
        pendingProgress = null;
      }
    });
  }

  function makeChip(tag) {
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    chip.textContent = tag;
    chip.title = "点击复制";
    chip.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(tag);
        log(`已复制: ${tag}`, "info");
      } catch {
        log(`复制失败: ${tag}`, "error");
      }
    });
    return chip;
  }

  function updateBadge() {
    const n = availableTags.length;
    const shown = Math.min(n, MAX_VISIBLE_CHIPS);
    els.resultsBadge.textContent =
      n > MAX_VISIBLE_CHIPS ? `${formatNumber(n)}（显示最近 ${shown}）` : String(n);
  }

  /** 只渲染最近 MAX_VISIBLE_CHIPS 个，避免 DOM 爆炸 */
  function renderResults() {
    updateBadge();
    els.results.innerHTML = "";
    if (availableTags.length === 0) return;

    const frag = document.createDocumentFragment();
    if (availableTags.length > MAX_VISIBLE_CHIPS) {
      const hint = document.createElement("div");
      hint.className = "results-hint";
      hint.textContent = `仅显示最近 ${MAX_VISIBLE_CHIPS} 个，完整列表请导出（共 ${formatNumber(availableTags.length)}）`;
      frag.appendChild(hint);
    }
    const start = Math.max(0, availableTags.length - MAX_VISIBLE_CHIPS);
    // 最新的在前
    for (let i = availableTags.length - 1; i >= start; i--) {
      frag.appendChild(makeChip(availableTags[i]));
    }
    els.results.appendChild(frag);
  }

  function flushPendingChips() {
    chipFlushTimer = 0;
    if (pendingChips.length === 0) return;

    const batch = pendingChips;
    pendingChips = [];

    // 最新的插到前面
    const frag = document.createDocumentFragment();
    for (let i = batch.length - 1; i >= 0; i--) {
      frag.appendChild(makeChip(batch[i]));
    }

    // 去掉「空状态」；若有 hint 保留在最前
    let first = els.results.firstChild;
    if (first && first.classList && first.classList.contains("results-hint")) {
      els.results.insertBefore(frag, first.nextSibling);
    } else {
      els.results.insertBefore(frag, els.results.firstChild);
    }

    // 超出可见上限则从尾部删
    while (els.results.childElementCount > MAX_VISIBLE_CHIPS + 1) {
      els.results.removeChild(els.results.lastChild);
    }
    // 若刚超过阈值，补一条提示
    if (
      availableTags.length > MAX_VISIBLE_CHIPS &&
      !(els.results.firstChild && els.results.firstChild.classList?.contains("results-hint"))
    ) {
      const hint = document.createElement("div");
      hint.className = "results-hint";
      hint.textContent = `仅显示最近 ${MAX_VISIBLE_CHIPS} 个，完整列表请导出（共 ${formatNumber(availableTags.length)}）`;
      els.results.insertBefore(hint, els.results.firstChild);
    }

    updateBadge();
  }

  function addAvailable(tag, opts = {}) {
    if (!tag || availableSet.has(tag)) return;
    availableSet.add(tag);
    availableTags.push(tag);

    if (opts.silent) {
      updateBadge();
      return;
    }

    pendingChips.push(tag);
    if (!chipFlushTimer) {
      // 批量刷 DOM，高并发时每 200ms 画一次
      chipFlushTimer = setTimeout(flushPendingChips, 200);
    }

    // found 日志节流
    foundSinceLog += 1;
    const now = Date.now();
    if (foundSinceLog === 1 || foundSinceLog % FOUND_LOG_EVERY === 0 || now - lastFoundLogAt > 2000) {
      log(`可用 +${foundSinceLog} · 最近: ${tag} · 累计 ${availableTags.length}`, "found");
      foundSinceLog = 0;
      lastFoundLogAt = now;
    }
  }

  function resetResults() {
    availableTags = [];
    availableSet = new Set();
    pendingChips = [];
    if (chipFlushTimer) {
      clearTimeout(chipFlushTimer);
      chipFlushTimer = 0;
    }
    foundSinceLog = 0;
    els.results.innerHTML = "";
    updateBadge();
  }

  function log(msg, level = "") {
    const line = document.createElement("div");
    line.className = `line ${level}`;
    const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    line.textContent = `[${ts}] ${msg}`;
    els.log.appendChild(line);
    // 限制日志条数
    while (els.log.children.length > 200) {
      els.log.removeChild(els.log.firstChild);
    }
    // 滚动节流：仅接近底部时跟着滚
    if (els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 80) {
      els.log.scrollTop = els.log.scrollHeight;
    }
  }

  function connectSSE() {
    if (eventSource) {
      eventSource.close();
    }
    eventSource = new EventSource("/api/scan/events");
    eventSource.addEventListener("scan", (ev) => {
      try {
        const data = JSON.parse(ev.data);
        handleEvent(data);
      } catch (e) {
        console.error(e);
      }
    });
    eventSource.onerror = () => {
      // 浏览器会自动重连
    };
  }

  function handleEvent(data) {
    switch (data.type) {
      case "started":
        setStatus("running");
        resetResults();
        updateProgress({
          checked: 0,
          total: data.total,
          available: 0,
          taken: 0,
          errors: 0,
          rate_per_sec: 0,
          elapsed_secs: 0,
          eta_secs: null,
        });
        log(`扫描开始，共 ${formatNumber(data.total)} 个`, "info");
        break;
      case "progress":
        updateProgress(data);
        // 用服务端计数校正 badge（SSE 可能丢 found）
        if (typeof data.available === "number") {
          els.statAvailable.textContent = formatNumber(data.available);
          if (data.available > availableTags.length) {
            els.resultsBadge.textContent =
              data.available > MAX_VISIBLE_CHIPS
                ? `${formatNumber(data.available)}（显示最近 ${Math.min(availableTags.length, MAX_VISIBLE_CHIPS)}）`
                : String(data.available);
          }
        }
        break;
      case "found":
        addAvailable(data.result.tag);
        break;
      case "checked":
        break;
      case "error":
        log(data.message, "error");
        break;
      case "finished":
        flushPendingChips();
        setStatus(data.status);
        updateProgress({
          checked: data.checked,
          total: data.checked,
          available: data.available,
          taken: data.taken,
          errors: data.errors,
          rate_per_sec: data.elapsed_secs > 0 ? data.checked / data.elapsed_secs : 0,
          elapsed_secs: data.elapsed_secs,
          eta_secs: 0,
        });
        log(
          `结束 [${data.status}] 检查 ${formatNumber(data.checked)} · 可用 ${data.available} · 占用 ${data.taken} · 错误 ${data.errors} · 用时 ${formatDuration(data.elapsed_secs)}`,
          "info"
        );
        // 结束后再全量同步一次结果（用于导出）
        syncResultsFromServer();
        break;
    }
  }

  async function refreshStatus({ syncResults = false } = {}) {
    try {
      const res = await fetch("/api/scan/status");
      const data = await res.json();
      setStatus(data.status);
      if (data.progress) {
        updateProgress(data.progress);
        if (data.progress.current) {
          els.currentTag.textContent = data.progress.current;
        }
      }
      // 扫描中不要反复拉上万条结果，只在结束/手动时同步
      if (syncResults || data.status !== "running") {
        if (data.results_count > 0 && data.results_count !== availableTags.length) {
          await syncResultsFromServer();
        }
      } else if (data.results_count != null) {
        updateBadgeFromCount(data.results_count);
      }
    } catch (e) {
      console.error(e);
    }
  }

  function updateBadgeFromCount(n) {
    const shown = Math.min(availableTags.length, MAX_VISIBLE_CHIPS);
    els.resultsBadge.textContent =
      n > MAX_VISIBLE_CHIPS ? `${formatNumber(n)}（显示最近 ${shown}）` : String(n);
  }

  async function syncResultsFromServer() {
    try {
      const r = await fetch("/api/scan/results");
      const list = await r.json();
      availableTags = list.map((x) => x.tag);
      availableSet = new Set(availableTags);
      renderResults();
    } catch (e) {
      console.error(e);
    }
  }

  function buildConfig() {
    const length = getLength();
    const endRaw = els.endIndex.value.trim();
    let concurrency = parseInt(els.concurrency.value, 10) || 10;
    if (concurrency > 50) {
      // 前端硬限，避免再次卡死
      concurrency = 50;
      els.concurrency.value = "50";
      log("并发已限制为 50（过高会导致页面卡顿）", "info");
    }
    return {
      length,
      charset: els.charset.value,
      concurrency,
      delay_ms: parseInt(els.delayMs.value, 10) || 0,
      prefix: els.prefix.value.trim() || null,
      suffix: els.suffix.value.trim() || null,
      only_store_available: true,
      start_index: parseInt(els.startIndex.value, 10) || 0,
      end_index: endRaw === "" ? null : parseInt(endRaw, 10),
    };
  }

  async function startScan() {
    const config = buildConfig();
    if (config.length < 3 || config.length > 8) {
      alert("字符长度必须在 3–8 之间");
      return;
    }
    try {
      const res = await fetch("/api/scan/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const data = await res.json();
      if (!data.ok) {
        alert(data.message || "启动失败");
        return;
      }
      resetResults();
      log(data.message, "info");
      setStatus("running");
    } catch (e) {
      alert(String(e));
    }
  }

  async function stopScan() {
    try {
      const res = await fetch("/api/scan/stop", { method: "POST" });
      const data = await res.json();
      log(data.message || "停止", "info");
    } catch (e) {
      alert(String(e));
    }
  }

  async function checkOne() {
    const tag = els.singleTag.value.trim();
    if (!tag) return;
    els.singleResult.textContent = "查询中…";
    try {
      const res = await fetch(`/api/check?tag=${encodeURIComponent(tag)}`);
      const data = await res.json();
      if (!res.ok) {
        els.singleResult.innerHTML = `<span class="no">${data.error || "失败"}</span>`;
        return;
      }
      if (data.available) {
        els.singleResult.innerHTML = `<span class="ok">✓ 可用：${data.normalized || tag}</span>`;
        addAvailable(data.tag || tag);
        flushPendingChips();
      } else {
        els.singleResult.innerHTML = `<span class="no">✗ 已占用：${data.normalized || tag}${
          data.code ? ` (${data.code})` : ""
        }</span>`;
      }
    } catch (e) {
      els.singleResult.innerHTML = `<span class="no">${e}</span>`;
    }
  }

  async function exportTags(asJson) {
    // 导出前尽量从服务端拉全量，避免 SSE 丢事件
    if (isRunning || availableTags.length === 0) {
      await syncResultsFromServer();
    }
    if (asJson) {
      download(
        `available-tags-${Date.now()}.json`,
        JSON.stringify(availableTags, null, 2),
        "application/json"
      );
    } else {
      download(
        `available-tags-${Date.now()}.txt`,
        availableTags.join("\n") + (availableTags.length ? "\n" : ""),
        "text/plain"
      );
    }
  }

  function download(filename, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // length buttons
  els.lengthGroup.addEventListener("click", (e) => {
    const btn = e.target.closest(".len-btn");
    if (!btn) return;
    els.lengthGroup.querySelectorAll(".len-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const len = btn.dataset.len;
    if (len === "custom") {
      selectedLength = "custom";
      els.customLength.classList.remove("hidden");
    } else {
      selectedLength = parseInt(len, 10);
      els.customLength.classList.add("hidden");
    }
    updateEstimate();
  });

  // charset cards
  els.charsetGroup.addEventListener("click", (e) => {
    const card = e.target.closest(".charset-card");
    if (!card) return;
    selectCharset(card.dataset.charset);
  });

  els.charsetGroup.addEventListener("keydown", (e) => {
    const cards = [...els.charsetGroup.querySelectorAll(".charset-card")];
    const idx = cards.findIndex((c) => c.classList.contains("active"));
    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault();
      const next = cards[(idx + 1) % cards.length];
      selectCharset(next.dataset.charset);
      next.focus();
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      const prev = cards[(idx - 1 + cards.length) % cards.length];
      selectCharset(prev.dataset.charset);
      prev.focus();
    }
  });

  [
    els.concurrency,
    els.delayMs,
    els.prefix,
    els.suffix,
    els.startIndex,
    els.endIndex,
    els.customLength,
  ].forEach((el) => {
    el.addEventListener("input", updateEstimate);
    el.addEventListener("change", updateEstimate);
  });

  els.btnStart.addEventListener("click", startScan);
  els.btnStop.addEventListener("click", stopScan);
  els.btnCheck.addEventListener("click", checkOne);
  els.singleTag.addEventListener("keydown", (e) => {
    if (e.key === "Enter") checkOne();
  });

  els.btnExport.addEventListener("click", () => exportTags(true));
  els.btnExportTxt.addEventListener("click", () => exportTags(false));

  els.btnClear.addEventListener("click", async () => {
    if (!confirm("确定清空已发现的可用标签？")) return;
    try {
      await fetch("/api/scan/results/clear", { method: "POST" });
    } catch {
      /* ignore */
    }
    resetResults();
  });

  els.btnClearLog.addEventListener("click", () => {
    els.log.innerHTML = "";
  });

  // init
  updateEstimate();
  connectSSE();
  refreshStatus({ syncResults: true });
  // 扫描中只同步状态，不拉全量结果
  setInterval(() => {
    if (isRunning) {
      refreshStatus({ syncResults: false });
    }
  }, 3000);

  log("就绪。请配置字符长度后开始扫描。", "info");
})();
