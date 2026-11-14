// content.js — floating toolbar + scraper + auto-paste + web search + ChatGPT + Antigravity
(function () {
  const IS_PROBLEM_PAGE = /\/(problems|learn|practice)\//.test(location.pathname);
  if (!IS_PROBLEM_PAGE) return;
  if (document.querySelector(".cc-toolbar")) return;

  const POS_KEY = "cc-toolbar-pos";
  const LANGS = ["cpp", "python", "java", "javascript"];

  // ---------- Scraper ----------
  function pick(selectors, root = document) {
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (el && el.innerText && el.innerText.trim().length) return el.innerText.trim();
    }
    return "";
  }

  function sliceByHeadings(text) {
    const lines = text.split("\n");
    let mode = "statement";
    const buckets = { statement: [], input: [], output: [], constraints: [], notes: [], skipped: [] };
    const notesRe = /^(sample|example|explanation|author|difficulty|tags?|source|time limit|memory limit)\b/i;
    for (const line of lines) {
      const t = line.trim().toLowerCase();
      if (/^(input|input format)\b/.test(t)) { mode = "input"; continue; }
      if (/^(output|output format)\b/.test(t)) { mode = "output"; continue; }
      if (/^constraints\b/.test(t)) { mode = "constraints"; continue; }
      if (/^notes?\b/.test(t)) { mode = "notes"; continue; }
      if (notesRe.test(t)) { mode = "skipped"; continue; }
      buckets[mode].push(line);
    }
    return {
      statement: buckets.statement.join("\n").trim(),
      input: buckets.input.join("\n").trim(),
      output: buckets.output.join("\n").trim(),
      constraints: buckets.constraints.join("\n").trim(),
      notes: buckets.notes.join("\n").trim()
    };
  }

  function extractSamples(container) {
    const samples = [];
    const pres = Array.from(container.querySelectorAll("pre"));
    for (let i = 0; i < pres.length; i++) {
      const prev = pres[i].previousElementSibling;
      const label = ((prev && prev.innerText) || "").toLowerCase();
      if (label.includes("input")) {
        const next = pres[i + 1];
        samples.push({ input: pres[i].innerText.trim(), output: next ? next.innerText.trim() : "" });
        i++;
      }
    }
    if (samples.length) return samples;
    for (let i = 0; i < pres.length - 1; i += 2) {
      samples.push({ input: pres[i].innerText.trim(), output: pres[i + 1].innerText.trim() });
    }
    return samples;
  }

  function scrapeProblem() {
    const codeMatch = location.pathname.match(/\/problems\/([A-Za-z0-9_]+)/);
    const pathParts = location.pathname.split("/").filter(Boolean);
    const code = codeMatch ? codeMatch[1] : (pathParts[pathParts.length - 1] || "");
    const title =
      pick(["h1", ".problem-statement h1", "[class*='ProblemTitle']", "[class*='_title']", "[class*='heading']"]) ||
      code || document.title;
    const container =
      document.querySelector(".problem-statement") ||
      document.querySelector("[class*='problem-statement']") ||
      document.querySelector("[class*='ProblemStatement']") ||
      document.querySelector("[class*='problem-description']") ||
      document.querySelector("[class*='problem-desc']") ||
      document.querySelector("[class*='content-container']") ||
      document.querySelector("main") ||
      document.body;
    const sliced = sliceByHeadings(container.innerText || "");
    const rawText = (container.innerText || "").trim();
    const finalStatement = (sliced.statement && sliced.statement.length > 30) ? sliced.statement : rawText;

    const difficulty = pick(["[class*='difficulty']", "[class*='Difficulty']"]);
    const tagEls = document.querySelectorAll("[class*='tag'] a, a[href*='/tags/'], [class*='Tag']");
    const tags = Array.from(tagEls)
      .map((e) => e.innerText.trim()).filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i).slice(0, 20);
    return {
      title, code,
      url: location.href.split("#")[0].split("?")[0],
      difficulty, tags,
      statement: finalStatement,
      inputFormat: sliced.input,
      outputFormat: sliced.output,
      constraints: sliced.constraints,
      samples: extractSamples(container),
      notes: "", solution: "", language: "", status: "unsolved"
    };
  }

  function renderAll(p) {
    const out = [];
    out.push(`# ${p.title} (${p.code})`);
    out.push(p.url);
    if (p.difficulty) out.push(`Difficulty: ${p.difficulty}`);
    if (p.tags && p.tags.length) out.push(`Tags: ${p.tags.join(", ")}`);
    out.push("", "## Statement", p.statement);
    if (p.inputFormat) out.push("\n## Input", p.inputFormat);
    if (p.outputFormat) out.push("\n## Output", p.outputFormat);
    if (p.constraints) out.push("\n## Constraints", p.constraints);
    if (p.samples && p.samples.length) {
      out.push("\n## Samples");
      p.samples.forEach((s, i) => {
        out.push(`\nSample ${i + 1} Input:\n${s.input}`);
        out.push(`Sample ${i + 1} Output:\n${s.output}`);
      });
    }
    return out.join("\n");
  }

  async function pasteCodeIntoEditor(code) {
    try {
      const res = await chrome.runtime.sendMessage({ type: "CC_BROADCAST_INJECT", code });
      if (res && res.ok) return res;
      return res || { ok: false, error: "Inject failed." };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  function normalizeLang(str) {
    if (!str) return null;
    const s = String(str).toLowerCase();
    if (s.includes("cpp") || s.includes("c++") || s === "cc" || s === "cxx") return "cpp";
    if (s.includes("python") || s === "py") return "python";
    if (s.includes("java") && !s.includes("javascript")) return "java";
    if (s.includes("javascript") || s === "js" || s === "ts" || s.includes("typescript")) return "javascript";
    return LANGS.includes(s) ? s : null;
  }

  async function probeEditorLanguage() {
    try {
      const res = await chrome.runtime.sendMessage({ type: "CC_PROBE_EDITOR_BROADCAST" });
      if (res && res.ok) return normalizeLang(res.language) || res.language || null;
    } catch {}
    return null;
  }

  async function readClipboard() {
    try { return await navigator.clipboard.readText(); }
    catch (e) { throw new Error("Clipboard read blocked. Click the page once, then retry."); }
  }

  async function autoPasteBest() {
    const p = scrapeProblem();
    const editorLang = await probeEditorLanguage();
    let lookup = null;
    try { lookup = await chrome.runtime.sendMessage({ type: "CC_GET_BY_URL", url: p.url }); } catch {}

    const saved = lookup && lookup.item;
    let chosenCode = null;
    let reason = "";

    if (saved) {
      const map = saved.solutions && typeof saved.solutions === "object" ? saved.solutions : {};
      if (editorLang && map[editorLang] && map[editorLang].trim()) {
        chosenCode = map[editorLang]; reason = `saved ${editorLang} solution`;
      }
      if (!chosenCode && editorLang && saved.language === editorLang && saved.solution && saved.solution.trim()) {
        chosenCode = saved.solution; reason = `saved ${editorLang} solution (legacy)`;
      }
      if (!chosenCode && saved.status === "solved" && saved.solution && saved.solution.trim()) {
        chosenCode = saved.solution; reason = `saved solution (${saved.language || "any"})`;
      }
      if (!chosenCode) {
        const filled = LANGS.find((l) => map[l] && String(map[l]).trim());
        if (filled) {
          chosenCode = map[filled];
          reason = `saved ${filled} solution (any language)`;
        }
      }
      if (!chosenCode && saved.solution && saved.solution.trim()) {
        chosenCode = saved.solution; reason = "saved solution (fallback)";
      }
    }

    if (!chosenCode) {
      try {
        const clip = await readClipboard();
        if (clip && clip.trim()) { chosenCode = clip; reason = "clipboard"; }
      } catch {}
    }

    if (!chosenCode) {
      throw new Error(
        "Nothing local to paste. Try 🤖 Ask ChatGPT, or 🔍 Search GitHub."
      );
    }

    const inj = await pasteCodeIntoEditor(chosenCode);
    if (!inj.ok) throw new Error(inj.error || "Inject failed.");
    return { ok: true, kind: inj.kind, language: normalizeLang(inj.language) || inj.language || editorLang, reason };
  }

  // ---------- Web search helpers ----------
  function normalizeLangForGitHub(lang) {
    if (!lang) return "";
    const l = String(lang).toLowerCase();
    if (l.includes("cpp") || l.includes("c++")) return "cpp";
    if (l.includes("python")) return "python";
    if (l.includes("java")) return "java";
    if (l.includes("javascript") || l === "js") return "javascript";
    return "";
  }

  async function getSearchContext() {
    const p = scrapeProblem();
    const editorLang = await probeEditorLanguage();
    return { problem: p, language: editorLang };
  }

  function openTab(url) {
    try { chrome.runtime.sendMessage({ type: "CC_OPEN_URL", url }); }
    catch { window.open(url, "_blank"); }
  }

  async function searchGitHub() {
    const { problem, language } = await getSearchContext();
    if (!problem.code) throw new Error("No problem code found in URL.");
    const ghLang = normalizeLangForGitHub(language);
    const q = ["codechef", problem.code, ghLang ? `language:${ghLang}` : ""].filter(Boolean).join(" ");
    const url = "https://github.com/search?type=code&q=" + encodeURIComponent(q);
    openTab(url);
    return { ok: true, url };
  }

  async function searchAll() {
    const { problem } = await getSearchContext();
    if (!problem.code) throw new Error("No problem code found in URL.");
    const q = `${problem.code} codechef solution (site:github.com OR site:discuss.codechef.com OR site:codereview.stackexchange.com OR site:gist.github.com)`;
    const url = "https://www.google.com/search?q=" + encodeURIComponent(q);
    openTab(url);
    return { ok: true, url };
  }

  async function searchDiscuss() {
    const { problem } = await getSearchContext();
    if (!problem.code) throw new Error("No problem code found in URL.");
    const url = "https://discuss.codechef.com/search?q=" + encodeURIComponent(problem.code);
    openTab(url);
    return { ok: true, url };
  }

  // ---------- ChatGPT integration ----------
  function languageForPrompt(lang) {
    if (!lang) return "C++";
    const l = String(lang).toLowerCase();
    if (l.includes("python")) return "Python";
    if (l.includes("java")) return "Java";
    if (l.includes("javascript")) return "JavaScript";
    return "C++";
  }

  function buildChatGPTPrompt(problem, language, maxStatement) {
    const lang = languageForPrompt(language);
    let statement = problem.statement || "(not captured)";
    if (maxStatement && statement.length > maxStatement) {
      statement = statement.slice(0, maxStatement) + "\n…(truncated)";
    }
    const samples = (problem.samples || [])
      .map((s, i) =>
        `Sample ${i + 1}:\nInput:\n${s.input}\nOutput:\n${s.output}`
      )
      .join("\n\n");

    return [
      `Solve this CodeChef problem in ${lang}. Give me the complete, compilable source code that reads from stdin and writes to stdout — nothing else, no explanation.`,
      ``,
      `Problem: ${problem.title} (${problem.code})`,
      `URL: ${problem.url}`,
      ``,
      `Statement:`,
      statement,
      problem.constraints ? `\nConstraints:\n${problem.constraints}` : "",
      problem.inputFormat ? `\nInput format:\n${problem.inputFormat}` : "",
      problem.outputFormat ? `\nOutput format:\n${problem.outputFormat}` : "",
      samples ? `\nSamples:\n${samples}` : "",
      ``,
      `Return ONLY the final ${lang} code in a single fenced code block. No prose before or after.`
    ].filter(Boolean).join("\n");
  }

  function extractCode(text) {
    if (!text) return "";
    const m = text.match(/```(?:[a-zA-Z0-9+#]+)?\s*\n([\s\S]*?)```/);
    if (m) return m[1].trim();
    return text.trim();
  }

  async function askChatGPT() {
    const p = scrapeProblem();
    if (!p.statement || p.statement.length < 40) {
      throw new Error("Could not scrape a statement from this page. Scroll to load it, then retry.");
    }
    const lang = await probeEditorLanguage();

    let settings = {};
    try { settings = await chrome.storage.local.get("cc-settings"); } catch {}
    const s = settings["cc-settings"] || {};

    if (s.useAPI && s.apiKey) {
      const prompt = buildChatGPTPrompt(p, lang);
      const model = s.model || "gpt-4o-mini";
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + s.apiKey
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: "You are an expert competitive programmer. Reply only with code inside a single fenced block." },
            { role: "user", content: prompt }
          ],
          temperature: 0.2
        })
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`OpenAI ${res.status}: ${txt.slice(0, 200)}`);
      }
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content || "";
      const code = extractCode(content);
      if (!code) throw new Error("No code block found in ChatGPT's reply.");
      const inj = await pasteCodeIntoEditor(code);
      if (!inj.ok) throw new Error(inj.error || "Inject failed.");
      return { ok: true, mode: "api", kind: inj.kind, model };
    }

    const prompt = buildChatGPTPrompt(p, lang, 2500);
    const url = "https://chatgpt.com/?q=" + encodeURIComponent(prompt);
    openTab(url);
    return { ok: true, mode: "web", url };
  }

  async function antigravitySolveAndSubmit(statusSetter = () => {}) {
    statusSetter("Analyzing page…");
    const p = scrapeProblem();

    // Check if Worked Example (code is pre-filled, just needs Run)
    const isWorkedExample = /worked example/i.test(p.title || "") || /worked example/i.test(p.statement || "");
    if (isWorkedExample) {
      statusSetter("Worked example detected — executing Run…");
      await chrome.runtime.sendMessage({ type: "CC_BROADCAST_SUBMIT" });
      await new Promise((r) => setTimeout(r, 1200));
      statusSetter("✅ Worked example run completed!");
      return { ok: true, submitted: true, workedExample: true };
    }

    // Check if multiple choice quiz
    const radios = document.querySelectorAll("input[type='radio'], [role='radio']");
    if (radios.length && !document.querySelector(".monaco-editor") && !document.querySelector("textarea")) {
      statusSetter("Quiz question detected — submitting answer…");
      radios[0].click();
      await chrome.runtime.sendMessage({ type: "CC_BROADCAST_SUBMIT" });
      statusSetter("✅ Quiz option submitted!");
      return { ok: true, submitted: true, quiz: true };
    }

    if (!p.statement || p.statement.length < 20) {
      throw new Error("Could not extract problem statement from this page. Please ensure the problem is fully loaded.");
    }
    let editorLang = await probeEditorLanguage();
    if (!editorLang) {
      const isML = /(-ml-|_ml_|ml|python|data-science)/i.test(location.href) ||
                   /(pandas|dataframe|sklearn|numpy|read_csv)/i.test(p.statement);
      editorLang = isML ? "python" : "cpp";
    }
    let existingCode = "";
    try {
      const edRes = await chrome.runtime.sendMessage({ type: "CC_GET_EDITOR_CONTENT" });
      if (edRes && edRes.ok && edRes.content) {
        existingCode = edRes.content;
      }
    } catch {}

    if (existingCode && (existingCode.includes("____") || existingCode.includes("TODO") || existingCode.includes("Step 1"))) {
      statusSetter("Analyzing starter template in editor & completing blanks…");
    } else {
      statusSetter(`⚡ Antigravity solving (${editorLang})…`);
    }

    const res = await chrome.runtime.sendMessage({
      type: "CC_SOLVE_WITH_ANTIGRAVITY",
      problem: p,
      language: editorLang,
      existing_code: existingCode
    });

    if (!res || !res.ok) {
      throw new Error(res?.error || "Failed to receive solution from Antigravity Bridge.");
    }

    // Always copy code to clipboard as guaranteed backup
    try { await navigator.clipboard.writeText(res.code); } catch {}

    statusSetter("📥 Replacing editor with complete verified solution…");
    const inj = await pasteCodeIntoEditor(res.code);

    statusSetter("▶ Executing Run to test against test cases…");
    await new Promise((r) => setTimeout(r, 700));

    const runRes = await chrome.runtime.sendMessage({ type: "CC_RUN_CODE" });
    if (runRes && runRes.ok) {
      statusSetter("▶ Code running! Waiting for test results…");
      return { ok: true, submitted: false };
    } else {
      statusSetter("⚠️ Code injected! Click Run to test.");
      return { ok: true, submitted: false };
    }
  }

  function findPrevButton(doc = document) {
    const selectors = [
      "button[data-cy*='prev' i]",
      "a[data-cy*='prev' i]",
      "[data-cy='prev-btn']",
      "[data-cy='previous-btn']",
      "[data-cy='back-btn']",
      "button.prev-btn",
      "a.prev-btn",
      "button[class*='prev' i]",
      "a[class*='prev' i]",
      "button[class*='previous' i]",
      "a[class*='previous' i]"
    ];
    for (const s of selectors) {
      const el = doc.querySelector(s);
      if (el && el.offsetParent !== null && !el.disabled) return el;
    }
    const candidates = Array.from(doc.querySelectorAll("button, a, [role='button'], span"));
    return candidates.find((b) => {
      if (b.disabled || b.offsetParent === null) return false;
      const t = (b.innerText || b.getAttribute("aria-label") || "").trim().toLowerCase();
      return /^(prev|< prev|previous|< previous|back)$/i.test(t) || t.includes("prev") || t.includes("previous");
    }) || null;
  }

  function findNextButton(doc = document) {
    const selectors = [
      "button[data-cy*='next' i]",
      "a[data-cy*='next' i]",
      "[data-cy='next-btn']",
      "[data-cy='continue-btn']",
      "button[class*='next' i]",
      "a[class*='next' i]",
      "button[class*='continue' i]",
      "a[class*='continue' i]"
    ];
    for (const s of selectors) {
      const el = doc.querySelector(s);
      if (el && el.offsetParent !== null && !el.disabled) return el;
    }
    const candidates = Array.from(doc.querySelectorAll("button, a, [role='button']"));
    return candidates.find((b) => {
      if (b.disabled || b.offsetParent === null) return false;
      const t = (b.innerText || "").trim().toLowerCase();
      return t === "next" || t === "next problem" || t === "continue" || t === "next exercise" || t === "next question" || t.startsWith("next ");
    }) || null;
  }

  async function autoSolveAndAdvance(statusSetter = () => {}) {
    sessionStorage.setItem("cc_auto_advance", "1");
    statusSetter("Starting auto-course solver…");

    // If on syllabus/overview page with problem links
    const isProblemView = document.querySelector(".monaco-editor") || document.querySelector("textarea") || document.querySelector("[class*='problem-statement']");
    if (!isProblemView) {
      const links = Array.from(document.querySelectorAll("a[href*='/learn/']")).filter(a => /\/(problem|practice|lesson|topics?)\//.test(a.href));
      if (links.length) {
        statusSetter(`Navigating to first lesson…`);
        links[0].click();
        return;
      }
    }

    try {
      await antigravitySolveAndSubmit(statusSetter);
    } catch (e) {
      statusSetter("Solve error: " + (e.message || e), true);
      sessionStorage.removeItem("cc_auto_advance");
      return;
    }

    statusSetter("Waiting for verdict & Next button…");
    statusSetter("Waiting for test cases to pass…");
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      if (sessionStorage.getItem("cc_auto_advance") !== "1") {
        clearInterval(interval);
        statusSetter("Auto-advance stopped.");
        return;
      }

      // Check verdict across all frames
      let verdictRes = null;
      try {
        verdictRes = await chrome.runtime.sendMessage({ type: "CC_CHECK_VERDICT" });
      } catch {}

      const v = verdictRes ? verdictRes.verdict : "unknown";

      if (v === "failed") {
        clearInterval(interval);
        sessionStorage.removeItem("cc_auto_advance");
        statusSetter("❌ Test cases failed! Stopped to prevent wrong answer submission.", true);
        const stopBtn = document.querySelector("[data-cc='stop-advance']");
        const startBtn = document.querySelector("[data-cc='auto-advance']");
        if (stopBtn) stopBtn.style.display = "none";
        if (startBtn) startBtn.style.display = "block";
        return;
      }

      if (v === "running") {
        statusSetter(`Evaluating test cases… (${attempts}s)`);
        return;
      }

      // STRICT: ONLY submit & advance if all test cases passed!
      if (v === "passed") {
        clearInterval(interval);
        statusSetter("✅ All test cases passed! Submitting final code…");
        try {
          await chrome.runtime.sendMessage({ type: "CC_BROADCAST_SUBMIT_ONLY" });
        } catch {}
        await new Promise((r) => setTimeout(r, 1500));

        statusSetter("✅ Submitted! Advancing to next problem in 2s…");
        setTimeout(() => {
          const nextBtn = findNextButton(document);
          if (nextBtn) {
            nextBtn.click();
          } else {
            chrome.runtime.sendMessage({ type: "CC_BROADCAST_CLICK_NEXT" });
          }
        }, 1800);
        return;
      }

      if (attempts >= 40) {
        clearInterval(interval);
        sessionStorage.removeItem("cc_auto_advance");
        statusSetter("⚠️ Tests did not finish passing within 45s. Halting.", true);
        const stopBtn = document.querySelector("[data-cc='stop-advance']");
        const startBtn = document.querySelector("[data-cc='auto-advance']");
        if (stopBtn) stopBtn.style.display = "none";
        if (startBtn) startBtn.style.display = "block";
      }
    }, 1200);
  }

  // ---------- Draggable toolbar ----------
  function applyPosition(bar, pos) {
    if (!pos || typeof pos.left !== "number" || typeof pos.top !== "number") return;
    const w = bar.offsetWidth || 240;
    const h = bar.offsetHeight || 320;
    const maxLeft = Math.max(0, window.innerWidth - w);
    const maxTop = Math.max(0, window.innerHeight - h);
    bar.style.left = Math.min(Math.max(0, pos.left), maxLeft) + "px";
    bar.style.top = Math.min(Math.max(0, pos.top), maxTop) + "px";
    bar.style.right = "auto";
    bar.style.bottom = "auto";
  }

  function getSavedPosition() {
    return new Promise((resolve) => {
      try { chrome.storage.local.get(POS_KEY, (got) => resolve(got && got[POS_KEY] ? got[POS_KEY] : null)); }
      catch { resolve(null); }
    });
  }
  function savePosition(pos) {
    try { chrome.storage.local.set({ [POS_KEY]: pos }); } catch {}
  }

  function makeDraggable(bar, handle) {
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;
    let dragging = false, moved = false;

    handle.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".cc-close")) return;
      if (e.button !== 0 && e.pointerType === "mouse") return;
      const rect = bar.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      startLeft = rect.left; startTop = rect.top;
      dragging = true; moved = false;
      handle.setPointerCapture(e.pointerId);
      handle.classList.add("dragging");
      bar.style.transition = "none";
      e.preventDefault();
    });

    handle.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      const w = bar.offsetWidth || 240;
      const h = bar.offsetHeight || 320;
      const maxLeft = Math.max(0, window.innerWidth - w);
      const maxTop = Math.max(0, window.innerHeight - h);
      const left = Math.min(Math.max(0, startLeft + dx), maxLeft);
      const top = Math.min(Math.max(0, startTop + dy), maxTop);
      bar.style.left = left + "px";
      bar.style.top = top + "px";
      bar.style.right = "auto";
      bar.style.bottom = "auto";
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove("dragging");
      if (handle.hasPointerCapture && handle.hasPointerCapture(e.pointerId)) {
        try { handle.releasePointerCapture(e.pointerId); } catch {}
      }
      bar.style.transition = "";
      if (moved) {
        const rect = bar.getBoundingClientRect();
        savePosition({ left: rect.left, top: rect.top });
      }
    }
    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);

    window.addEventListener("resize", () => {
      const rect = bar.getBoundingClientRect();
      const w = bar.offsetWidth || 240;
      const h = bar.offsetHeight || 320;
      const left = Math.min(Math.max(0, rect.left), Math.max(0, window.innerWidth - w));
      const top = Math.min(Math.max(0, rect.top), Math.max(0, window.innerHeight - h));
      bar.style.left = left + "px";
      bar.style.top = top + "px";
      bar.style.right = "auto";
      bar.style.bottom = "auto";
      savePosition({ left, top });
    });
  }

  // ---------- UI ----------
  function buildToolbar() {
    const bar = document.createElement("div");
    bar.className = "cc-toolbar";
    bar.innerHTML = `
      <div class="cc-bar-head">
        <span class="cc-drag-hint" aria-hidden="true">⋮⋮</span>
        <span class="cc-logo">CC</span>
        <span class="cc-title">Companion</span>
        <button class="cc-close" title="Hide">×</button>
      </div>
      <div class="cc-body">
        <button data-cc="auto-advance" class="cc-auto-advance">🚀 Auto-Complete (Waits for Pass)</button>
        <button data-cc="stop-advance" class="cc-stop-advance" style="display:none">⏹️ Stop Auto-Advance</button>
        <button data-cc="antigravity-solve" class="cc-antigravity">⚡ Antigravity Solve & Run</button>
        <div style="display:flex;gap:4px;margin-top:2px;">
          <button data-cc="click-prev" style="flex:1;text-align:center;">⏮️ Prev</button>
          <button data-cc="click-run" style="flex:1;text-align:center;font-weight:700;">▶ Run</button>
          <button data-cc="click-next" style="flex:1;text-align:center;">⏭️ Next</button>
        </div>
        <button data-cc="ask-chatgpt" class="cc-gpt">🤖 Ask ChatGPT</button>
        <button data-cc="auto-paste" class="cc-auto">⚡ Auto-paste (my solutions)</button>
        <button data-cc="paste-clipboard" class="cc-paste">📋 Paste clipboard → editor</button>

        <div class="cc-section-title">Find a solution online</div>
        <button data-cc="search-github">🔍 Search GitHub</button>
        <button data-cc="search-all">🔎 Search all sites</button>
        <button data-cc="search-discuss">📚 CodeChef Discuss</button>

        <div class="cc-section-title">Copy problem</div>
        <button data-cc="copy-all">📋 Copy everything</button>
        <button data-cc="copy-statement">Statement</button>
        <button data-cc="copy-input">Input</button>
        <button data-cc="copy-output">Output</button>
        <button data-cc="copy-constraints">Constraints</button>
        <button data-cc="copy-samples">Samples</button>

        <div class="cc-section-title">Library</div>
        <button data-cc="save" class="cc-primary">💾 Save to Library</button>
        <button data-cc="download">⬇️ Download bundle</button>
        <button data-cc="open-library">🗂️ Open Library</button>
        <button data-cc="open-settings">⚙️ Settings</button>

        <div class="cc-status" aria-live="polite"></div>
      </div>
    `;
    (document.body || document.documentElement).appendChild(bar);

    bar.querySelector(".cc-close").onclick = () => bar.remove();

    getSavedPosition().then((pos) => {
      if (pos) applyPosition(bar, pos);
      makeDraggable(bar, bar.querySelector(".cc-bar-head"));
    });

    bar.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-cc]");
      if (!btn) return;
      const action = btn.dataset.cc;
      const status = bar.querySelector(".cc-status");
      const flash = (msg, isErr) => {
        status.textContent = msg;
        status.style.color = isErr ? "#dc2626" : "#059669";
        status.classList.add("show");
        clearTimeout(flash._t);
        flash._t = setTimeout(() => status.classList.remove("show"), 2600);
      };

      try {
        if (action === "auto-advance") {
          btn.style.display = "none";
          const stopBtn = bar.querySelector("[data-cc='stop-advance']");
          if (stopBtn) stopBtn.style.display = "block";
          await autoSolveAndAdvance(flash);
          return;
        }
        if (action === "stop-advance") {
          sessionStorage.removeItem("cc_auto_advance");
          btn.style.display = "none";
          const startBtn = bar.querySelector("[data-cc='auto-advance']");
          if (startBtn) startBtn.style.display = "block";
          flash("Auto-advance stopped.");
          return;
        }
        if (action === "click-prev") {
          const prev = findPrevButton(document);
          if (prev) { prev.click(); flash("Navigating to previous problem…"); }
          else {
            chrome.runtime.sendMessage({ type: "CC_BROADCAST_CLICK_PREV" }).then((r) => {
              if (r && r.ok) flash("Navigating to previous problem…");
              else flash("Previous button not found.", true);
            });
          }
          return;
        }
        if (action === "click-run") {
          flash("Executing Run / Submit…");
          await chrome.runtime.sendMessage({ type: "CC_BROADCAST_SUBMIT" });
          return;
        }
        if (action === "click-next") {
          const next = findNextButton(document);
          if (next) { next.click(); flash("Navigating to next problem…"); }
          else {
            chrome.runtime.sendMessage({ type: "CC_BROADCAST_CLICK_NEXT" }).then((r) => {
              if (r && r.ok) flash("Navigating to next problem…");
              else flash("Next button not found.", true);
            });
          }
          return;
        }
        if (action === "antigravity-solve") {
          await antigravitySolveAndSubmit(flash);
          return;
        }
        if (action === "ask-chatgpt") {
          flash("Preparing prompt…");
          const r = await askChatGPT();
          if (r.mode === "web") flash("Opened ChatGPT with prompt — press Enter there, then copy code back");
          else flash(`AI pasted directly (${r.model})`);
          return;
        }
        if (action === "auto-paste") {
          flash("Finding best match…");
          const r = await autoPasteBest();
          flash(`Pasted ${r.language || r.kind} — ${r.reason}`);
          return;
        }
        if (action === "search-github") {
          flash("Opening GitHub search…");
          await searchGitHub();
          flash("Opened GitHub in a new tab");
          return;
        }
        if (action === "search-all") {
          flash("Opening web search…");
          await searchAll();
          flash("Opened Google in a new tab");
          return;
        }
        if (action === "search-discuss") {
          flash("Opening Discuss search…");
          await searchDiscuss();
          flash("Opened Discuss in a new tab");
          return;
        }
        if (action === "open-settings") {
          chrome.runtime.sendMessage({ type: "CC_OPEN_SETTINGS" });
          return;
        }

        const p = scrapeProblem();

        if (action === "paste-clipboard") {
          flash("Reading clipboard…");
          const text = await readClipboard();
          if (!text || !text.trim()) throw new Error("Clipboard is empty.");
          const inj = await pasteCodeIntoEditor(text);
          if (!inj.ok) throw new Error(inj.error || "Inject failed.");
          flash(`Pasted clipboard (${inj.kind})`);
        } else if (action === "copy-all") {
          await navigator.clipboard.writeText(renderAll(p));
          flash("Copied everything");
        } else if (action === "copy-statement") {
          await navigator.clipboard.writeText(p.statement);
          flash("Statement copied");
        } else if (action === "copy-input") {
          await navigator.clipboard.writeText(p.inputFormat || "(none found)");
          flash("Input spec copied");
        } else if (action === "copy-output") {
          await navigator.clipboard.writeText(p.outputFormat || "(none found)");
          flash("Output spec copied");
        } else if (action === "copy-constraints") {
          await navigator.clipboard.writeText(p.constraints || "(none found)");
          flash("Constraints copied");
        } else if (action === "copy-samples") {
          const s = (p.samples || []).map((x, i) =>
            `Sample ${i + 1} Input:\n${x.input}\n\nSample ${i + 1} Output:\n${x.output}`
          ).join("\n\n");
          await navigator.clipboard.writeText(s || "(no samples found)");
          flash("Samples copied");
        } else if (action === "save") {
          const res = await chrome.runtime.sendMessage({ type: "CC_SAVE_PROBLEM", problem: p });
          if (res.ok) flash(`Saved as #${res.record.id}`);
          else flash("Save failed: " + res.error, true);
        } else if (action === "download") {
          chrome.runtime.sendMessage({ type: "CC_DOWNLOAD_BUNDLE", problem: p });
          flash("Downloading bundle…");
        } else if (action === "open-library") {
          chrome.runtime.sendMessage({ type: "CC_OPEN_LIBRARY" });
        }
      } catch (err) {
        console.error(err);
        flash("Error: " + (err.message || err), true);
      }
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "CC_COPY_ALL") {
      const p = scrapeProblem();
      navigator.clipboard.writeText(renderAll(p))
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    if (msg.type === "CC_SCRAPE_NOW") {
      sendResponse({ ok: true, problem: scrapeProblem() });
      return true;
    }
    if (msg.type === "CC_TRIGGER_DOWNLOAD") {
      const p = scrapeProblem();
      chrome.runtime.sendMessage({ type: "CC_DOWNLOAD_BUNDLE", problem: p });
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === "CC_PASTE_SOLUTION") {
      pasteCodeIntoEditor(msg.code).then(sendResponse);
      return true;
    }
    if (msg.type === "CC_PASTE_CLIPBOARD") {
      (async () => {
        try {
          const text = await readClipboard();
          if (!text || !text.trim()) throw new Error("Clipboard is empty.");
          const inj = await pasteCodeIntoEditor(text);
          sendResponse({ ok: !!inj.ok, kind: inj.kind, error: inj.error });
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
      })();
      return true;
    }
    if (msg.type === "CC_AUTO_PASTE") {
      (async () => {
        try {
          const r = await autoPasteBest();
          sendResponse({ ok: true, kind: r.kind, language: r.language, reason: r.reason });
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
      })();
      return true;
    }
    if (msg.type === "CC_CLICK_PREV") {
      const prev = findPrevButton(document);
      if (prev) { prev.click(); sendResponse({ ok: true }); }
      else {
        chrome.runtime.sendMessage({ type: "CC_BROADCAST_CLICK_PREV" }).then(sendResponse);
      }
      return true;
    }
    if (msg.type === "CC_CLICK_NEXT") {
      const next = findNextButton(document);
      if (next) { next.click(); sendResponse({ ok: true }); }
      else {
        chrome.runtime.sendMessage({ type: "CC_BROADCAST_CLICK_NEXT" }).then(sendResponse);
      }
      return true;
    }
    if (msg.type === "CC_ANTIGRAVITY_SOLVE") {
      (async () => {
        try {
          const bar = document.querySelector(".cc-toolbar");
          const status = bar ? bar.querySelector(".cc-status") : null;
          const flash = (m, isErr) => {
            if (!status) return;
            status.textContent = m;
            status.style.color = isErr ? "#dc2626" : "#059669";
            status.classList.add("show");
            setTimeout(() => status.classList.remove("show"), 2600);
          };
          const r = await antigravitySolveAndSubmit(flash);
          sendResponse({ ok: true, submitted: r.submitted });
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
      })();
      return true;
    }
    if (msg.type === "CC_AUTO_COMPLETE") {
      (async () => {
        try {
          const bar = document.querySelector(".cc-toolbar") || buildToolbar();
          const status = bar ? bar.querySelector(".cc-status") : null;
          const flash = (m, isErr) => {
            if (!status) return;
            status.textContent = m;
            status.style.color = isErr ? "#dc2626" : "#059669";
            status.classList.add("show");
            setTimeout(() => status.classList.remove("show"), 2600);
          };
          autoSolveAndAdvance(flash);
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
      })();
      return true;
    }
    if (msg.type === "CC_STOP_AUTO") {
      sessionStorage.removeItem("cc_auto_advance");
      const bar = document.querySelector(".cc-toolbar");
      if (bar) {
        const startBtn = bar.querySelector("[data-cc='auto-advance']");
        const stopBtn = bar.querySelector("[data-cc='stop-advance']");
        if (startBtn) startBtn.style.display = "block";
        if (stopBtn) stopBtn.style.display = "none";
        const status = bar.querySelector(".cc-status");
        if (status) {
          status.textContent = "Auto-advance stopped.";
          status.style.color = "#dc2626";
          status.classList.add("show");
          setTimeout(() => status.classList.remove("show"), 2600);
        }
      }
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === "CC_RUN_CODE") {
      chrome.runtime.sendMessage({ type: "CC_BROADCAST_SUBMIT" }).then((r) => {
        sendResponse(r || { ok: true });
      });
      return true;
    }
    if (msg.type === "CC_TOGGLE_TOOLBAR") {
      let bar = document.querySelector(".cc-toolbar");
      if (!bar) {
        bar = buildToolbar();
        sendResponse({ ok: true, visible: true });
      } else {
        if (bar.style.display === "none") {
          bar.style.display = "block";
          sendResponse({ ok: true, visible: true });
        } else {
          bar.style.display = "none";
          sendResponse({ ok: true, visible: false });
        }
      }
      return true;
    }
    if (msg.type === "CC_GET_AUTO_STATUS") {
      sendResponse({ ok: true, active: sessionStorage.getItem("cc_auto_advance") === "1" });
      return true;
    }
    if (msg.type === "CC_ASK_CHATGPT") {
      (async () => {
        try {
          const r = await askChatGPT();
          sendResponse({ ok: true, mode: r.mode, kind: r.kind, model: r.model });
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
      })();
      return true;
    }
    if (msg.type === "CC_SEARCH_GITHUB") {
      searchGitHub().then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    }
    if (msg.type === "CC_SEARCH_ALL") {
      searchAll().then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    }
    if (msg.type === "CC_SEARCH_DISCUSS") {
      searchDiscuss().then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    }
    if (msg.type === "CC_PROBE_EDITOR_VIA_CONTENT") {
      (async () => {
        const lang = await probeEditorLanguage();
        sendResponse({ ok: true, language: lang });
      })();
      return true;
    }
    if (msg.type === "CC_RESET_POSITION") {
      chrome.storage.local.remove(POS_KEY, () => {
        const bar = document.querySelector(".cc-toolbar");
        if (bar) {
          bar.style.left = "";
          bar.style.top = "";
          bar.style.right = "16px";
          bar.style.bottom = "16px";
        }
        sendResponse({ ok: true });
      });
      return true;
    }
  });

  function initAutoAdvance() {
    buildToolbar();
    if (sessionStorage.getItem("cc_auto_advance") === "1") {
      setTimeout(() => {
        const bar = document.querySelector(".cc-toolbar");
        if (!bar) return;
        const startBtn = bar.querySelector("[data-cc='auto-advance']");
        const stopBtn = bar.querySelector("[data-cc='stop-advance']");
        if (startBtn) startBtn.style.display = "none";
        if (stopBtn) stopBtn.style.display = "block";
        const status = bar.querySelector(".cc-status");
        const flash = (m, isErr) => {
          if (!status) return;
          status.textContent = m;
          status.style.color = isErr ? "#dc2626" : "#059669";
          status.classList.add("show");
        };
        flash("Auto-advance: solving next problem…");
        autoSolveAndAdvance(flash);
      }, 2500);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAutoAdvance);
  } else {
    initAutoAdvance();
  }

  // SPA navigation watcher
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (!document.querySelector(".cc-toolbar")) {
        initAutoAdvance();
      }
    }
  }, 1000);
})();
