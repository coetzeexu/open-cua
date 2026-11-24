(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const pretty = (value) => JSON.stringify(value, null, 2) ?? "—";
  const short = (value) => String(value ?? "").slice(0, 8);
  const ms = (n) =>
    n == null
      ? "—"
      : n < 1000
        ? `${Math.round(n)}ms`
        : `${(n / 1000).toFixed(n < 10000 ? 2 : 1)}s`;
  const time = (n) =>
    n
      ? new Date(n).toLocaleString("zh-CN", {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        })
      : "—";
  const labels = {
    succeeded: "校验通过",
    failed: "失败",
    cancelled: "已取消",
    unverified: "未确认",
    incomplete: "记录未结束",
    running: "执行中",
    queued: "排队中",
    abandoned: "已中止",
  };
  const modeLabels = {
    run: "普通运行",
    validation: "版本验证",
    exploration: "来源 / 探索",
  };
  const badge = (status, label) =>
    `<span class="badge ${esc(status)}">${esc(label ?? labels[status] ?? status)}</span>`;
  const jsonBlock = (value) =>
    `<pre class="json-block">${esc(typeof value === "string" ? value : pretty(value))}</pre>`;
  const token = document.querySelector("meta[name=cua-token]").content;
  const hash = new URLSearchParams(location.hash.slice(1));
  let selectedRecipe = hash.get("recipe") || null,
    selectedRun = hash.get("run") || null;
  let snapshot = null,
    recipe = null,
    trace = null,
    version = null,
    tab = "runs",
    traceTab = "output",
    selectedSpan = null,
    historyMode = false;
  let collapsed = new Set(),
    fingerprint = "",
    loading = false,
    recipeLoad = 0,
    traceLoad = 0,
    runForm = null;
  const blobUrls = new Set();
  try {
    document.documentElement.dataset.theme =
      localStorage.getItem("cua-theme") || "light";
  } catch {}
  const api = async (path, options = {}) => {
    const response = await fetch(path, {
      ...options,
      headers: {
        "x-cua-token": token,
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
    });
    if (!response.ok) {
      let message = `请求失败 (${response.status})`;
      try {
        message = (await response.json()).error || message;
      } catch {}
      throw Error(message);
    }
    return response.json();
  };
  function notice(message) {
    $("notice").textContent = message;
    $("notice").hidden = !message;
  }
  function syncHash() {
    const p = new URLSearchParams();
    if (selectedRecipe) p.set("recipe", selectedRecipe);
    if (selectedRun) p.set("run", selectedRun);
    history.replaceState(null, "", `#${p}`);
  }
  function item() {
    return snapshot?.recipes.find((r) => r.name === selectedRecipe);
  }
  function scopedRuns() {
    if (!snapshot) return [];
    const r = item();
    const runs = r
      ? snapshot.runs.filter(
          (v) => v.name === r.name || r.sources.includes(v.runId),
        )
      : snapshot.runs;
    const filter = $("run-filter").value;
    return runs.filter((r) => filter === "all" || r.mode === filter);
  }
  function jobs() {
    return (snapshot?.jobs ?? []).filter(
      (j) => !selectedRecipe || j.name === selectedRecipe,
    );
  }
  function runStatus(run) {
    return jobs().find((j) => j.runId === run.runId && j.status === "running")
      ? "running"
      : run.status;
  }
  function renderStats() {
    const stats = item()?.stats ?? snapshot.stats;
    const rate =
      stats.successRate == null
        ? "—"
        : `${Math.round(stats.successRate * 100)}<small>%</small>`;
    $("stats").innerHTML = [
      [
        "普通运行",
        stats.total,
        `${stats.validations} 次版本验证，单独记录`,
        "↗",
      ],
      [
        "校验通过率",
        rate,
        `${stats.passed} 通过 / ${stats.failed} 失败或取消 / ${stats.unverified} 未确认`,
        "◎",
      ],
      [
        "平均执行耗时",
        ms(stats.averageMs),
        "已结束普通运行 · CUA 单元累计",
        "◷",
      ],
      [
        "脚本版本",
        item()
          ? item().versions.length
          : snapshot.recipes.reduce((n, r) => n + r.versions.length, 0),
        item()
          ? `${item().active ? "1 个激活版本" : "尚无激活版本"}`
          : `${snapshot.recipes.length} 个脚本 · ${snapshot.recipes.filter((r) => r.active).length} 个已激活`,
        "⌘",
      ],
    ]
      .map(
        ([label, value, note, icon]) =>
          `<div class="stat"><div class="stat-label">${label}<span>${icon}</span></div><div class="stat-value">${value}</div><div class="stat-note">${esc(note)}</div></div>`,
      )
      .join("");
  }
  function renderNav() {
    const search = $("search").value.toLowerCase();
    $("recipe-count").textContent = snapshot.recipes.length;
    $("recipe-nav").innerHTML =
      snapshot.recipes
        .filter((r) =>
          `${r.name} ${r.description}`.toLowerCase().includes(search),
        )
        .map(
          (r) =>
            `<button class="recipe-nav-item ${selectedRecipe === r.name ? "selected" : ""}" data-recipe="${esc(r.name)}"><span class="nav-icon">{ }</span><div><strong>${esc(r.name)}</strong><small>${r.versions.length} 个版本 · ${r.stats.total} 次运行</small></div>${r.active ? "<i></i>" : ""}</button>`,
        )
        .join("") || '<div class="loading muted">没有匹配的脚本</div>';
    document
      .querySelector(".nav-all")
      .classList.toggle("selected", !selectedRecipe && !historyMode);
    document
      .querySelector(".history-nav")
      .classList.toggle("selected", historyMode);
  }
  function renderOverview() {
    renderNav();
    renderStats();
    const r = item();
    $("page-heading").textContent = r
      ? "脚本详情"
      : historyMode
        ? "全部执行历史"
        : "脚本执行中心";
    $("page-description").textContent = r
      ? r.description
      : "从脚本到每一步执行，所有记录都在这里。";
    $("catalog").hidden = !!r || historyMode;
    $("catalog").innerHTML = snapshot.recipes.length
      ? snapshot.recipes
          .map(
            (r) =>
              `<button class="recipe-card" data-recipe="${esc(r.name)}"><div class="recipe-card-top"><span class="script-icon">{ }</span><h3>${esc(r.name)}</h3></div><p>${esc(r.description)}</p><div class="recipe-card-bottom"><span>${r.active ? "● 已激活" : "○ 草稿"}</span><span><b>${r.stats.total}</b> 次运行</span><span><b>${r.stats.successRate == null ? "—" : Math.round(r.stats.successRate * 100) + "%"}</b> 校验通过</span><span style="margin-left:auto">↗</span></div></button>`,
          )
          .join("")
      : '<div class="empty"><h3>还没有脚本</h3><p>用 cua-recipes Skill 沉淀流程并导入后，脚本会出现在这里。</p></div>';
    $("recipe-header").hidden = !r;
    if (r)
      $("recipe-header").innerHTML =
        `<div class="recipe-meta"><span class="script-icon">{ }</span><div><h2>${esc(r.name)}</h2><p>${r.active ? `激活版本 <span class="mono">${short(r.active)}</span>` : "尚无激活版本"} · ${r.versions.length} 个不可变版本</p></div></div><div class="recipe-actions"><select id="version-select" aria-label="查看版本">${r.versions.map((v) => `<option value="${esc(v.version)}" ${v.version === version ? "selected" : ""}>${short(v.version)}${v.version === r.active ? " · Active" : " · 非激活"}</option>`).join("")}</select><button class="button primary" data-action="run" ${!r.active || !snapshot.historyEnabled ? "disabled" : ""}>▶ 运行脚本</button></div>`;
    document.querySelector("[data-tab=code]").disabled = !r;
    document.querySelector("[data-tab=versions]").disabled = !r;
    $("storage-note").textContent = snapshot.configLabel
      ? `配置：${snapshot.configLabel}`
      : "只统计实际记录 · 不估算模型成本或 Token";
    renderRuns();
    renderTabs();
    if (recipe && recipe.name === selectedRecipe) {
      renderCode();
      renderVersions();
    }
  }
  function renderRuns() {
    const runs = scopedRuns();
    $("run-count").textContent = runs.length;
    const outstanding = jobs().filter((j) =>
      ["running", "queued"].includes(j.status),
    );
    const notRecorded = outstanding.filter(
      (j) => !runs.some((r) => r.runId === j.runId),
    );
    $("run-list").innerHTML =
      notRecorded
        .map(
          (j) =>
            `<div class="job-strip">${badge(j.status)}<span>${esc(j.name)}<br>正在创建执行记录…</span></div>`,
        )
        .join("") +
      runs
        .map(
          (r) =>
            `<button class="run-item ${selectedRun === r.runId ? "selected" : ""}" data-run="${esc(r.runId)}"><div class="run-top"><span class="run-time">${time(r.start)}</span>${badge(runStatus(r))}</div><div class="run-sub"><span>${modeLabels[r.mode]}</span><span>${ms(r.metrics.durationMs)}</span></div><div class="run-id">${short(r.runId)} · ${r.metrics.operations} ops${r.version ? " · " + short(r.version) : ""}</div></button>`,
        )
        .join("") +
      (!runs.length && !notRecorded.length
        ? '<div class="empty"><div class="empty-symbol">◷</div><h3>暂无执行记录</h3><p>执行脚本后，Trace 会自动出现在这里。</p></div>'
        : "");
    const failedJobs = jobs().filter(
      (j) =>
        j.status === "failed" &&
        !snapshot.runs.some((r) => r.runId === j.runId),
    );
    if (failedJobs.length)
      $("run-list").innerHTML += failedJobs
        .map(
          (j) =>
            `<div class="trace-alert">启动失败 · ${esc(j.name)}<br>${esc(j.error)}</div>`,
        )
        .join("");
  }
  function renderTabs() {
    for (const name of ["runs", "code", "versions"]) {
      $(`${name}-panel`).hidden = name !== tab;
      document
        .querySelector(`[data-tab=${name}]`)
        .setAttribute("aria-selected", String(name === tab));
    }
  }
  async function chooseRecipe(name) {
    selectedRecipe = name;
    historyMode = false;
    selectedRun = null;
    trace = null;
    selectedSpan = null;
    collapsed.clear();
    version = null;
    recipe = null;
    tab = "runs";
    $("detail-drawer").hidden = true;
    if (name) {
      const r = item();
      version = r?.active ?? r?.versions[0]?.version;
    }
    syncHash();
    renderOverview();
    renderTrace();
    if (name) await loadRecipe();
    if (selectedRecipe !== name) return;
    const run = scopedRuns()[0];
    if (run) await chooseRun(run.runId);
    else renderTrace();
  }
  async function loadRecipe() {
    if (!selectedRecipe || !version) return;
    const sequence = ++recipeLoad;
    try {
      const next = await api(
        `/api/recipes/${encodeURIComponent(selectedRecipe)}?version=${encodeURIComponent(version)}`,
      );
      if (
        sequence !== recipeLoad ||
        next.name !== selectedRecipe ||
        next.version !== version
      )
        return;
      recipe = next;
      renderCode();
      renderVersions();
    } catch (e) {
      notice(e.message);
    }
  }
  async function chooseRun(id) {
    selectedRun = id;
    trace = null;
    selectedSpan = null;
    collapsed.clear();
    $("detail-drawer").hidden = true;
    syncHash();
    renderRuns();
    $("trace").innerHTML =
      '<div class="empty"><div class="empty-symbol">⌁</div><h3>正在读取 Trace…</h3></div>';
    await loadTrace();
  }
  async function loadTrace() {
    if (!selectedRun) return;
    const id = selectedRun,
      sequence = ++traceLoad;
    try {
      const next = await api(`/api/runs/${encodeURIComponent(id)}`);
      if (id !== selectedRun || sequence !== traceLoad) return;
      const changed =
        !trace ||
        trace.eventCount !== next.eventCount ||
        trace.status !== next.status;
      trace = next;
      if (changed) {
        renderTrace();
        if (selectedSpan) renderSpan(selectedSpan);
      }
    } catch (e) {
      if (id !== selectedRun || sequence !== traceLoad) return;
      $("trace").innerHTML =
        `<div class="empty"><h3>${esc(e.message)}</h3><p>任务刚入队时，记录需要稍后才能读取。</p></div>`;
    }
  }
  function renderTrace() {
    if (!trace) {
      $("trace").innerHTML =
        '<div class="empty"><div class="empty-symbol">⌁</div><h3>暂无 Trace</h3><p>运行记录与脚本会关联保存在本地。</p></div>';
      return;
    }
    const duration = Math.max(
      1,
      trace.end - trace.start,
      ...trace.spans.map((s) => s.end - trace.start),
    );
    const spanRows = trace.spans
      .filter((s) => !s.parentId || !collapsed.has(s.parentId))
      .map((s) => {
        const offset = Math.max(0, ((s.start - trace.start) / duration) * 100),
          width = Math.max(0.35, ((s.end - s.start) / duration) * 100);
        const failed = ["failed", "cancelled", "abandoned"].includes(s.status);
        return `<button class="span-row ${selectedSpan === s.id ? "selected" : ""}" data-span="${esc(s.id)}"><div class="span-label ${s.parentId ? "child" : ""}">${s.kind === "execution" ? `<span class="chevron" data-collapse="${esc(s.id)}">${collapsed.has(s.id) ? "▸" : "▾"}</span>` : ""}<span class="span-icon ${s.kind === "execution" ? "execution-icon" : ""}">${s.kind === "execution" ? "✦" : "◇"}</span><strong title="${esc(s.label)}">${esc(s.label)}</strong>${failed ? '<span class="span-error">!</span>' : ""}</div><div class="timeline"><span class="bar ${s.kind} ${esc(s.status)}" style="left:${offset}%;width:${Math.min(width, 100 - offset)}%" title="${esc(s.label)} · ${ms(s.end - s.start)}"></span>${offset + width < 83 ? `<span class="bar-label" style="left:${Math.min(offset + width + 1.5, 89)}%">${ms(s.end - s.start)}</span>` : ""}</div></button>`;
      })
      .join("");
    $("trace").innerHTML =
      `<div class="trace-title"><div><strong><span>✦</span>Trace</strong><small>${esc(trace.runId)}</small></div>${badge(runStatus(trace))}</div><div class="trace-metrics">${[
        ["总时间", ms(trace.durationMs)],
        ["执行耗时", ms(trace.metrics.durationMs)],
        ["SDK 操作", trace.metrics.operations],
        ["失败单元", trace.metrics.failedExecutions],
      ]
        .map(
          ([k, v]) =>
            `<div class="trace-metric"><small>${k}</small><b>${v}</b></div>`,
        )
        .join(
          "",
        )}</div>${trace.error ? `<div class="trace-alert">${esc(trace.error.code)} · ${esc(trace.error.message)}</div>` : ""}<div class="waterfall"><div class="time-axis"><div class="axis-label">SPAN / ${trace.spans.length}</div><div class="ticks">${[0, 25, 50, 75, 100].map((p) => `<span style="left:${p}%">${p === 0 ? "0s" : ms((duration * p) / 100)}</span>`).join("")}</div></div>${spanRows || '<div class="empty">尚无执行单元</div>'}</div><div class="trace-footer"><span><i class="purple"></i>执行单元　<i></i>SDK 调用</span><span>${trace.eventCount} 个原始事件 · 点击时间条查看详情</span></div><div class="trace-bottom"><div class="trace-subtabs">${[
        ["output", "运行结果"],
        ["params", "参数与检查"],
        ["evidence", "现场截图"],
        ["events", "原始事件"],
      ]
        .map(
          ([id, label]) =>
            `<button data-trace-tab="${id}" class="${traceTab === id ? "active" : ""}">${label}${id === "evidence" && trace.artifacts.length ? " · " + trace.artifacts.length : ""}</button>`,
        )
        .join("")}</div><div id="trace-content"></div></div>`;
    renderTraceContent();
  }
  function renderTraceContent() {
    const el = $("trace-content");
    if (!el || !trace) return;
    if (traceTab === "output") {
      el.innerHTML = trace.outputs.length
        ? trace.outputs
            .map((o) => {
              let parsed;
              try {
                parsed = JSON.parse(o.text);
              } catch {}
              if (parsed?.recipeVerified)
                return '<div class="section-note">✓ Runner 已执行 verify，返回校验通过标记。</div>';
              const rows = parsed?.products;
              if (
                Array.isArray(rows) &&
                rows.length &&
                rows.every(
                  (r) => r && typeof r === "object" && !Array.isArray(r),
                )
              ) {
                const keys = Object.keys(rows[0]).filter(
                  (k) => !["offerUrl", "url"].includes(k),
                );
                return `<div class="table-scroll"><table class="output-table"><thead><tr>${keys.map((k) => `<th>${esc(k)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${keys.map((k) => `<td title="${esc(typeof r[k] === "object" ? pretty(r[k]) : r[k])}">${esc(typeof r[k] === "object" ? pretty(r[k]) : r[k])}</td>`).join("")}</tr>`).join("")}</tbody></table></div><details class="event-row"><summary>展开完整结果 JSON</summary>${jsonBlock(parsed)}</details>`;
              }
              return jsonBlock(parsed ?? o.text ?? o);
            })
            .join("")
        : '<p class="section-note">本次执行没有记录输出。失败详情和截图可在相邻页签查看。</p>';
    } else if (traceTab === "params") {
      el.innerHTML = `<div class="section-note">${modeLabels[trace.mode]} · Profile: ${esc(trace.profile || "未记录")} · Version: ${esc(trace.version || "—")}</div>${jsonBlock(trace.params ?? {})}<div class="section-note">校验通过表示脚本 verify 通过，不替代对业务结果的复核。</div>${trace.analysis.blockers.length ? jsonBlock({ blockers: trace.analysis.blockers }) : ""}${trace.analysis.warnings.length ? jsonBlock({ warnings: trace.analysis.warnings }) : ""}`;
    } else if (traceTab === "evidence") {
      el.innerHTML = trace.artifacts.length
        ? trace.artifacts
            .map(
              (a) =>
                `<button class="artifact-button" data-artifact="${esc(a.eventId)}">▧ 查看截图 · ${time(a.time)}</button><div id="artifact-${esc(a.eventId)}"></div>`,
            )
            .join("")
        : '<p class="section-note">本次运行未记录可用截图。未采集或受私密保护的附件不会展示。</p>';
    } else {
      el.innerHTML = `<div class="section-note">${trace.events.length} 个事件。阶段事件完整保留，时间线上按调用合并。</div><label class="search"><input id="event-search" placeholder="筛选类型、ID 或错误文本…" aria-label="筛选事件"></label><div class="events-list" id="event-list"></div>`;
      renderEvents("");
    }
  }
  function renderEvents(query) {
    const events = trace.events.filter((e) =>
      `${e.type} ${e.id} ${pretty(e.data)}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    );
    $("event-list").innerHTML =
      events
        .slice(0, 150)
        .map(
          (e) =>
            `<details class="event-row"><summary><span>+${ms(e.time - trace.start)}</span><b>${esc(e.type)}</b></summary>${jsonBlock(e.data)}</details>`,
        )
        .join("") +
      (events.length > 150
        ? `<p class="section-note">匹配 ${events.length} 个事件，显示前 150 个。输入类型或 ID 缩小范围。</p>`
        : "");
  }
  function renderSpan(id) {
    const span = trace?.spans.find((s) => s.id === id);
    if (!span) return;
    selectedSpan = id;
    document
      .querySelectorAll("[data-span]")
      .forEach((el) => el.classList.toggle("selected", el.dataset.span === id));
    const events = trace.events.filter((e) => span.eventIds.includes(e.id));
    const start = events.find((e) =>
      ["sdk.started", "execution.started"].includes(e.type),
    );
    const finish = events.findLast((e) =>
      ["sdk.finished", "execution.finished"].includes(e.type),
    );
    const phases = events.filter((e) => e.type === "operation.changed");
    $("detail-drawer").hidden = false;
    $("detail-drawer").innerHTML =
      `<div class="drawer-header"><div><div class="eyebrow">SPAN DETAIL</div><h2>${esc(span.label)}</h2></div><button class="icon-button" data-action="close-drawer" aria-label="关闭调用详情">×</button></div>${badge(span.status, span.status === "succeeded" ? "调用完成" : undefined)} <span class="muted mono">${ms(span.end - span.start)}</span><h3>标识</h3>${jsonBlock({ id: span.id, start: new Date(span.start).toISOString(), end: new Date(span.end).toISOString() })}<h3>输入 / 执行代码</h3>${jsonBlock(start?.data ?? "未记录输入")}<h3>结果 / 错误</h3>${jsonBlock(finish?.data ?? "尚无结束事件")}<h3>操作阶段 · ${phases.length} 个事件</h3>${span.inferredOperationIds?.length ? '<p class="section-note">旧记录未带 callId；这些阶段按同会话、同执行单元、同方法及唯一包含的时间区间关联。</p>' : ""}<div class="phase-list">${phases.map((e) => `<div>+${ms(e.time - span.start)} · ${esc(e.data.phase)} ${esc(e.data.status || "")} ${esc(e.data.outcome || "")}</div>`).join("") || "未记录阶段事件"}</div>`;
  }
  function sourceCode(code) {
    return `<pre class="source-code">${String(code)
      .split("\n")
      .map((line) => `<span class="code-line">${esc(line) || " "}</span>`)
      .join("")}</pre>`;
  }
  function renderCode() {
    if (!recipe) return;
    $("code-panel").innerHTML =
      `<div class="section-note">只读查看 ${esc(recipe.name)} / ${short(recipe.version)}。脚本与校验在同一上下文执行；每次运行创建新会话。</div><div class="code-layout"><div><article class="code-card"><div class="card-title"><b>script.js</b><small>JAVASCRIPT · ${recipe.script.split("\n").length} LINES</small></div>${sourceCode(recipe.script)}</article><article class="code-card"><div class="card-title"><b>verify.js</b><small>BUSINESS ASSERTIONS</small></div>${sourceCode(recipe.verify)}</article></div><aside><article class="info-card"><div class="card-title">版本信息</div><div class="info-body"><dl><dt>VERSION</dt><dd>${esc(recipe.version)}</dd><dt>CREATED</dt><dd>${time(recipe.created)}</dd><dt>SOURCE RUN</dt><dd><button class="text-button" data-run="${esc(recipe.sourceRunId)}">${short(recipe.sourceRunId)} ↗</button></dd><dt>PARENT VERSION</dt><dd>${esc(recipe.parentVersion || "无")}</dd><dt>HASH</dt><dd>${esc(recipe.hash)}</dd></dl></div></article><article class="info-card"><div class="card-title">输入参数</div><div class="info-body">${
        Object.entries(recipe.parameters)
          .map(
            ([k, p]) =>
              `<dl><dt>${esc(k)} · ${esc(p.type)}${p.required ? " · 必填" : ""}</dt><dd>${esc(p.description || "—")}${p.default !== undefined ? `<br>默认值：${esc(typeof p.default === "object" ? JSON.stringify(p.default) : p.default)}` : ""}</dd></dl>`,
          )
          .join("") || "无参数"
      }</div></article><article class="info-card"><div class="card-title">运行前提</div><div class="info-body"><ul>${recipe.preconditions.map((p) => `<li>${esc(p)}</li>`).join("") || "<li>未声明</li>"}</ul></div></article></aside></div><details class="info-card"><summary class="card-title">来源决策与证据（Provenance）</summary>${jsonBlock(recipe.provenance ?? "旧版本未记录 provenance")}</details>`;
  }
  function renderVersions() {
    const r = item();
    if (!r) return;
    $("versions-panel").innerHTML =
      '<p class="section-note">验证记录表示当时的断言结果。版本内容不可变，只有已激活版本可快捷执行。</p>' +
      r.versions
        .map(
          (v) =>
            `<article class="version-card"><div class="version-head"><div><h3>${esc(v.version)}</h3><p>${time(v.created)} · Hash ${short(v.hash)}</p></div><div>${badge(v.version === r.active ? "succeeded" : "unverified", v.version === r.active ? "Active" : "非激活")} <button class="text-button" data-version="${esc(v.version)}">查看代码 ↗</button></div></div>${v.validations.length ? v.validations.map((x) => `<div class="validation-row">${badge(x.passed ? "succeeded" : "failed", x.passed ? "验证通过" : "验证失败")}<span>${esc(x.environment)} · ${time(x.time)}</span><button class="text-button" data-run="${esc(x.runId)}">Trace ${short(x.runId)} ↗</button></div>${x.quality?.blockers?.length ? jsonBlock(x.quality.blockers) : ""}`).join("") : '<div class="validation-row">尚无验证记录</div>'}</article>`,
        )
        .join("");
  }
  async function openRun() {
    const r = item();
    if (!r?.active) return;
    const active = await api(
      `/api/recipes/${encodeURIComponent(r.name)}?version=${encodeURIComponent(r.active)}`,
    );
    const recent = snapshot.runs.find(
      (x) => x.name === r.name && x.version === r.active && x.params,
    );
    const successful = snapshot.runs.find(
      (x) => x.name === r.name && x.version === r.active &&
        x.status === "succeeded" && x.businessSuccess === true &&
        snapshot.profiles.some((p) => p.name === x.profile),
    );
    const selectedProfile = successful?.profile ?? snapshot.defaultProfile;
    runForm = { recipe: active, requestId: crypto.randomUUID() };
    $("run-form-content").innerHTML =
      `<div class="dialog-recipe"><strong>${esc(r.name)}</strong><small>已激活版本 ${short(active.version)} · Runner 不调用模型</small></div><label class="field"><span class="field-heading">执行环境</span><select id="run-profile">${snapshot.profiles.map((p) => `<option value="${esc(p.name)}" ${p.name === selectedProfile ? "selected" : ""}>${esc(p.name)} · ${esc(p.provider)}</option>`).join("")}</select></label>${Object.entries(
        active.parameters,
      )
        .map(([k, p], i) => {
          const value = recent?.params?.[k] ?? p.default;
          const control =
            p.type === "object" || p.type === "array"
              ? `<textarea id="param-${i}" rows="10" ${p.required ? "required" : ""}>${esc(value === undefined ? "" : JSON.stringify(value, null, 2))}</textarea><details><summary>参数结构</summary>${jsonBlock(p)}</details>`
              : p.type === "boolean"
                ? `<select id="param-${i}">${!p.required ? '<option value="">不传入</option>' : ""}<option value="true" ${value === true ? "selected" : ""}>true</option><option value="false" ${value === false ? "selected" : ""}>false</option></select>`
                : `<input id="param-${i}" type="${p.type === "number" ? "number" : "text"}" ${p.type === "number" ? 'step="any"' : ""} ${p.required ? "required" : ""} value="${esc(value ?? "")}">`;
          return `<label class="field"><span class="field-heading">${esc(k)}${p.required ? " *" : ""}<small>${esc(p.type)}</small></span>${control}${p.description ? `<p>${esc(p.description)}</p>` : ""}</label>`;
        })
        .join(
          "",
        )}<p class="dialog-note">${successful ? "执行环境已沿用该版本最近成功运行的环境；登录状态仍需有效。" : "执行环境使用配置默认值，请确认登录所在环境。"}参数已从最近一次同版本运行或默认值填入，请核对。点击后将真实执行脚本；失败会保留 Trace，不自动重试。</p>`;
    $("form-error").textContent = "";
    $("submit-run").disabled = false;
    $("run-dialog").showModal();
  }
  $("run-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!runForm) return;
    const params = {};
    try {
      Object.entries(runForm.recipe.parameters).forEach(([k, p], i) => {
        const raw = $(`param-${i}`).value;
        if (raw === "" && !p.required) return;
        params[k] =
          p.type === "object" || p.type === "array"
            ? JSON.parse(raw)
            : p.type === "number"
              ? Number(raw)
              : p.type === "boolean"
                ? raw === "true"
                : raw;
      });
    } catch (e) {
      $("form-error").textContent = `参数 JSON 格式错误：${e.message}`;
      return;
    }
    $("submit-run").disabled = true;
    $("form-error").textContent = "";
    try {
      const job = await api("/api/runs", {
        method: "POST",
        body: JSON.stringify({
          name: runForm.recipe.name,
          version: runForm.recipe.version,
          params,
          profile: $("run-profile").value,
          requestId: runForm.requestId,
        }),
      });
      $("run-dialog").close();
      tab = "runs";
      $("run-filter").value = "all";
      selectedRun = job.runId;
      trace = null;
      syncHash();
      notice(`任务已提交 · ${short(job.runId)}。执行过程将自动刷新。`);
      await refresh(true);
    } catch (e) {
      $("form-error").textContent = e.message;
      $("submit-run").disabled = false;
    }
  });
  document.addEventListener("click", async (event) => {
    const target = event.target.closest("button,[data-collapse]");
    if (!target) return;
    try {
      if (target.dataset.collapse) {
        const id = target.dataset.collapse;
        collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id);
        renderTrace();
        return;
      }
      if (target.dataset.recipe) {
        await chooseRecipe(target.dataset.recipe);
        return;
      }
      if (target.dataset.run) {
        tab = "runs";
        renderTabs();
        await chooseRun(target.dataset.run);
        return;
      }
      if (target.dataset.tab) {
        tab = target.dataset.tab;
        renderTabs();
        return;
      }
      if (target.dataset.traceTab) {
        traceTab = target.dataset.traceTab;
        renderTrace();
        return;
      }
      if (target.dataset.span) {
        renderSpan(target.dataset.span);
        return;
      }
      if (target.dataset.version) {
        version = target.dataset.version;
        tab = "code";
        renderOverview();
        await loadRecipe();
        return;
      }
      if (target.dataset.artifact) {
        const id = target.dataset.artifact,
          runId = selectedRun;
        target.disabled = true;
        try {
          const response = await fetch(
            `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(id)}`,
            { headers: { "x-cua-token": token } },
          );
          if (!response.ok) throw Error("截图不可用或已被私密保护移除");
          const url = URL.createObjectURL(await response.blob());
          blobUrls.add(url);
          const destination = $(`artifact-${id}`);
          if (destination) {
            const image = document.createElement("img");
            image.src = url;
            image.className = "image-evidence";
            image.alt = "运行现场截图";
            destination.replaceChildren(image);
          }
        } catch (e) {
          target.disabled = false;
          throw e;
        }
        return;
      }
      switch (target.dataset.action) {
        case "all":
          historyMode = false;
          await chooseRecipe(null);
          break;
        case "history":
          await chooseRecipe(null);
          historyMode = true;
          renderOverview();
          break;
        case "refresh":
          notice("");
          await refresh(true);
          break;
        case "theme": {
          const value =
            document.documentElement.dataset.theme === "dark"
              ? "light"
              : "dark";
          document.documentElement.dataset.theme = value;
          try {
            localStorage.setItem("cua-theme", value);
          } catch {}
          break;
        }
        case "run":
          await openRun();
          break;
        case "close-dialog":
          $("run-dialog").close();
          break;
        case "close-drawer":
          $("detail-drawer").hidden = true;
          selectedSpan = null;
          break;
      }
    } catch (e) {
      notice(e.message);
    }
  });
  document.addEventListener("change", async (event) => {
    if (event.target.id === "version-select") {
      version = event.target.value;
      await loadRecipe();
    }
    if (event.target.id === "run-filter") {
      renderRuns();
      const runs = scopedRuns();
      if (!runs.some((r) => r.runId === selectedRun)) {
        selectedRun = null;
        trace = null;
        if (runs[0]) await chooseRun(runs[0].runId);
        else renderTrace();
      }
    }
  });
  document.addEventListener("input", (event) => {
    if (event.target.id === "search") renderNav();
    if (event.target.id === "event-search") renderEvents(event.target.value);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      $("detail-drawer").hidden = true;
      selectedSpan = null;
    }
  });
  async function refresh(force = false) {
    if (loading) return;
    loading = true;
    try {
      const next = await api("/api/state");
      const key = JSON.stringify(next),
        changed = key !== fingerprint;
      snapshot = next;
      fingerprint = key;
      $("sync-state").textContent =
        `已同步 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
      if (selectedRecipe && !item()) {
        selectedRecipe = null;
        version = null;
        recipe = null;
        tab = "runs";
      }
      if (selectedRecipe && !version)
        version = item().active ?? item().versions[0]?.version;
      if (changed || force) renderOverview();
      if (selectedRecipe && (!recipe || force)) await loadRecipe();
      if (!selectedRun && scopedRuns()[0]) selectedRun = scopedRuns()[0].runId;
      if (selectedRun) await loadTrace();
      else renderTrace();
      renderRuns();
      syncHash();
      if (next.warnings.length) notice(next.warnings.join("\n"));
      if (!next.historyEnabled)
        notice(
          "当前配置关闭了历史记录，快捷执行已禁用。请先启用 history.enabled。",
        );
    } catch (e) {
      $("sync-state").textContent = "连接中断";
      notice(e.message);
    } finally {
      loading = false;
    }
  }
  void refresh();
  setInterval(() => {
    if (!document.hidden) void refresh();
  }, 3000);
  window.addEventListener("beforeunload", () => {
    for (const url of blobUrls) URL.revokeObjectURL(url);
  });
})();
