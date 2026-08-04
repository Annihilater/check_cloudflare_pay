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

  let selectedLength = 3;
  let availableTags = [];
  let eventSource = null;

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
    // 实测约 1s/请求，按并发粗略估
    const estSecs =
      rangeClamped === 0n
        ? 0
        : Number(rangeClamped) / concurrency;

    updateCharsetCards();

    els.estimate.innerHTML = `预计组合数：<strong>${formatComboCount(rangeClamped)}</strong>
      · 字符集 ${size}<sup>${len}</sup> = ${formatComboCount(total)}
      · 粗估耗时（并发 ${concurrency}，~1s/请求）：<strong>${formatDuration(estSecs)}</strong>`;

    if (len >= 5 && els.charset.value === "alphanumeric") {
      els.estimate.innerHTML +=
        `<br><span style="color:#fbbf24">⚠ 5 位字母数字约 6046 万组合，全量扫描极慢，建议加前缀/后缀或限制索引范围。</span>`;
    }
  }

  function setStatus(status) {
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
    const running = status === "running";
    els.btnStart.disabled = running;
    els.btnStop.disabled = !running;
  }

  function updateProgress(p) {
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

  function renderResults() {
    els.resultsBadge.textContent = String(availableTags.length);
    els.results.innerHTML = "";
    const frag = document.createDocumentFragment();
    // 最新的在前
    for (let i = availableTags.length - 1; i >= 0; i--) {
      const tag = availableTags[i];
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
      frag.appendChild(chip);
    }
    els.results.appendChild(frag);
  }

  function addAvailable(tag) {
    if (!availableTags.includes(tag)) {
      availableTags.push(tag);
      renderResults();
    }
  }

  function log(msg, level = "") {
    const line = document.createElement("div");
    line.className = `line ${level}`;
    const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    line.textContent = `[${ts}] ${msg}`;
    els.log.appendChild(line);
    els.log.scrollTop = els.log.scrollHeight;
    // 限制日志条数
    while (els.log.children.length > 500) {
      els.log.removeChild(els.log.firstChild);
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
        availableTags = [];
        renderResults();
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
        break;
      case "found":
        addAvailable(data.result.tag);
        log(`可用: ${data.result.tag}`, "found");
        break;
      case "checked":
        // 默认不刷占用日志，避免刷屏
        break;
      case "error":
        log(data.message, "error");
        break;
      case "finished":
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
        refreshStatus();
        break;
    }
  }

  async function refreshStatus() {
    try {
      const res = await fetch("/api/scan/status");
      const data = await res.json();
      setStatus(data.status);
      if (data.progress) {
        updateProgress({
          ...data.progress,
          current: data.progress.current,
        });
        if (data.progress.current) {
          els.currentTag.textContent = data.progress.current;
        }
      }
      if (data.results_count != null) {
        // 同步结果列表
        const r = await fetch("/api/scan/results");
        const list = await r.json();
        availableTags = list.map((x) => x.tag);
        renderResults();
      }
    } catch (e) {
      console.error(e);
    }
  }

  function buildConfig() {
    const length = getLength();
    const endRaw = els.endIndex.value.trim();
    return {
      length,
      charset: els.charset.value,
      concurrency: parseInt(els.concurrency.value, 10) || 10,
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
      } else {
        els.singleResult.innerHTML = `<span class="no">✗ 已占用：${data.normalized || tag}${
          data.code ? ` (${data.code})` : ""
        }</span>`;
      }
    } catch (e) {
      els.singleResult.innerHTML = `<span class="no">${e}</span>`;
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

  els.btnExport.addEventListener("click", () => {
    download(
      `available-tags-${Date.now()}.json`,
      JSON.stringify(availableTags, null, 2),
      "application/json"
    );
  });

  els.btnExportTxt.addEventListener("click", () => {
    download(`available-tags-${Date.now()}.txt`, availableTags.join("\n") + "\n", "text/plain");
  });

  els.btnClear.addEventListener("click", async () => {
    if (!confirm("确定清空已发现的可用标签？")) return;
    try {
      await fetch("/api/scan/results/clear", { method: "POST" });
    } catch {
      /* ignore */
    }
    availableTags = [];
    renderResults();
  });

  els.btnClearLog.addEventListener("click", () => {
    els.log.innerHTML = "";
  });

  // init
  updateEstimate();
  connectSSE();
  refreshStatus();
  // 定时同步状态（SSE 丢事件时兜底）
  setInterval(() => {
    if (els.statusText.textContent === "扫描中") {
      refreshStatus();
    }
  }, 5000);

  log("就绪。请配置字符长度后开始扫描。", "info");
})();
