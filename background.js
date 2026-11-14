importScripts("db.js");

// ---- Persistence bootstrap ----
async function bootstrapPersistence() {
  try { await DB.syncMirror(); } catch (e) { console.warn("[CC] bootstrap persistence failed", e); }
}
chrome.runtime.onInstalled.addListener(bootstrapPersistence);
chrome.runtime.onStartup.addListener(bootstrapPersistence);
bootstrapPersistence();

async function resolveTab(sender) {
  if (sender && sender.tab && sender.tab.id) return sender.tab;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function normalizeLang(str) {
  if (!str) return null;
  const s = String(str).toLowerCase();
  if (s.includes("cpp") || s.includes("c++") || s === "cc" || s === "cxx") return "cpp";
  if (s.includes("python") || s === "py") return "python";
  if (s.includes("java") && !s.includes("javascript")) return "java";
  if (s.includes("javascript") || s === "js" || s === "ts" || s.includes("typescript")) return "javascript";
  return null;
}

// ---------- Context menus ----------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "cc-copy-all",
    title: "Copy problem (all sections)",
    contexts: ["page"],
    documentUrlPatterns: ["https://www.codechef.com/problems/*"]
  });
  chrome.contextMenus.create({
    id: "cc-auto-paste",
    title: "Auto-paste best matching solution",
    contexts: ["page"],
    documentUrlPatterns: ["https://www.codechef.com/problems/*"]
  });
  chrome.contextMenus.create({
    id: "cc-open-library",
    title: "Open CodeChef Companion Library",
    contexts: ["action", "page"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "cc-copy-all" && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: "CC_COPY_ALL" });
  } else if (info.menuItemId === "cc-auto-paste" && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: "CC_AUTO_PASTE" });
  } else if (info.menuItemId === "cc-open-library") {
    chrome.tabs.create({ url: chrome.runtime.getURL("library.html") });
  }
});

// ---------- Message hub ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "CC_SAVE_PROBLEM": {
          const existing = await DB.findByUrl(msg.problem.url);
          let record;
          if (existing) {
            record = await DB.put({
              ...existing,
              ...msg.problem,
              id: existing.id,
              solution: (msg.problem.solution && msg.problem.solution.trim()) ? msg.problem.solution : existing.solution,
              solutions: existing.solutions || msg.problem.solutions,
              language: msg.problem.language || existing.language,
              notes: existing.notes || msg.problem.notes || "",
              status: existing.status || msg.problem.status
            });
          } else {
            record = await DB.add(msg.problem);
          }
          sendResponse({ ok: true, record });
          break;
        }
        case "CC_LIST_PROBLEMS": {
          const items = await DB.all();
          items.sort((a, b) => b.updatedAt - a.updatedAt);
          sendResponse({ ok: true, items });
          break;
        }
        case "CC_GET_PROBLEM": {
          const item = await DB.get(msg.id);
          sendResponse({ ok: true, item });
          break;
        }
        case "CC_UPDATE_PROBLEM": { await DB.put(msg.problem); sendResponse({ ok: true }); break; }
        case "CC_DELETE_PROBLEM": { await DB.delete(msg.id); sendResponse({ ok: true }); break; }
        case "CC_GET_BY_URL": {
          const item = await DB.findByUrl(msg.url);
          sendResponse({ ok: true, item });
          break;
        }
        case "CC_OPEN_LIBRARY": {
          const url = chrome.runtime.getURL(
            msg.problemId ? `library.html?id=${msg.problemId}` : "library.html"
          );
          chrome.tabs.create({ url });
          sendResponse({ ok: true });
          break;
        }
        case "CC_DOWNLOAD_BUNDLE": { downloadBundle(msg.problem); sendResponse({ ok: true }); break; }
        case "CC_OPEN_URL": {
          if (!msg.url) { sendResponse({ ok: false, error: "no-url" }); break; }
          try {
            const u = new URL(msg.url);
            if (u.protocol !== "https:" && u.protocol !== "http:") {
              sendResponse({ ok: false, error: "bad-url" });
              break;
            }
            chrome.tabs.create({ url: msg.url, active: true });
            sendResponse({ ok: true });
          } catch {
            sendResponse({ ok: false, error: "bad-url" });
          }
          break;
        }
        case "CC_OPEN_SETTINGS": {
          chrome.runtime.openOptionsPage();
          sendResponse({ ok: true });
          break;
        }
        case "CC_BROADCAST_INJECT": {
          const tab = await resolveTab(sender);
          if (!tab || !tab.id) { sendResponse({ ok: false, error: "no-tab" }); break; }
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            world: "MAIN",
            func: injectIntoEditor,
            args: [msg.code]
          }).catch((e) => [{ result: { ok: false, error: String(e) } }]);
          const winner = (results || []).find((r) => r && r.result && r.result.ok);
          if (winner) {
            const r = winner.result;
            sendResponse({ ...r, language: normalizeLang(r.language) || r.language || null });
          } else {
            sendResponse({ ok: false, error: "No CodeChef editor found in any frame. Open the Submit page." });
          }
          break;
        }
        case "CC_PROBE_EDITOR_BROADCAST": {
          const tab = await resolveTab(sender);
          if (!tab || !tab.id) { sendResponse({ ok: false }); break; }
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            world: "MAIN",
            func: probeEditorInFrame
          }).catch(() => []);
          const winner = (results || []).find((r) => r && r.result && r.result.ok);
          if (winner) {
            const r = winner.result;
            sendResponse({ ...r, language: normalizeLang(r.language) || r.language || null });
          } else {
            sendResponse({ ok: false });
          }
          break;
        }
        case "CC_GET_EDITOR_CONTENT": {
          const tab = await resolveTab(sender);
          if (!tab || !tab.id) { sendResponse({ ok: false, content: "" }); break; }
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            world: "MAIN",
            func: getEditorContentInFrame
          }).catch(() => []);
          const winner = (results || []).find((r) => r && r.result && r.result.ok && r.result.content && r.result.content.trim().length > 0);
          sendResponse({ ok: true, content: winner ? winner.result.content : "" });
          break;
        }
        case "CC_SOLVE_WITH_ANTIGRAVITY": {
          try {
            const tab = await resolveTab(sender);
            let existingCode = msg.existing_code || "";

            // Automatically extract existing code from active editor if not explicitly passed
            if (!existingCode && tab && tab.id) {
              const results = await chrome.scripting.executeScript({
                target: { tabId: tab.id, allFrames: true },
                world: "MAIN",
                func: getEditorContentInFrame
              }).catch(() => []);
              const winner = (results || []).find((r) => r && r.result && r.result.ok && r.result.content && r.result.content.trim().length > 0);
              if (winner) {
                existingCode = winner.result.content;
              }
            }

            const bridgeRes = await fetch("http://127.0.0.1:8765/solve", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                problem: msg.problem,
                language: msg.language || "python",
                existing_code: existingCode
              })
            });
            if (!bridgeRes.ok) {
              const errTxt = await bridgeRes.text();
              sendResponse({ ok: false, error: `Bridge error (${bridgeRes.status}): ${errTxt}` });
              break;
            }
            const data = await bridgeRes.json();
            sendResponse(data);
          } catch (err) {
            sendResponse({
              ok: false,
              error: "Cannot connect to Antigravity Bridge at http://127.0.0.1:8765. Make sure bridge.py is running."
            });
          }
          break;
        }
        case "CC_RUN_CODE": {
          const tab = await resolveTab(sender);
          if (!tab || !tab.id) { sendResponse({ ok: false, error: "no-tab" }); break; }
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            world: "MAIN",
            func: clickRunInFrame
          }).catch((e) => [{ result: { ok: false, error: String(e) } }]);
          const winner = (results || []).find((r) => r && r.result && r.result.ok);
          sendResponse({ ok: !!winner });
          break;
        }
        case "CC_BROADCAST_SUBMIT_ONLY":
        case "CC_BROADCAST_SUBMIT": {
          const tab = await resolveTab(sender);
          if (!tab || !tab.id) { sendResponse({ ok: false, error: "no-tab" }); break; }
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            world: "MAIN",
            func: clickSubmitInFrame
          }).catch((e) => [{ result: { ok: false, error: String(e) } }]);
          const winner = (results || []).find((r) => r && r.result && r.result.ok);
          if (winner) {
            sendResponse({ ok: true, location: winner.result.location });
          } else {
            sendResponse({ ok: false, error: "Submit button could not be located on CodeChef page." });
          }
          break;
        }
        case "CC_BROADCAST_CLICK_NEXT": {
          const tab = await resolveTab(sender);
          if (!tab || !tab.id) { sendResponse({ ok: false, error: "no-tab" }); break; }
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            world: "MAIN",
            func: clickNextInFrame
          }).catch((e) => [{ result: { ok: false, error: String(e) } }]);
          const winner = (results || []).find((r) => r && r.result && r.result.ok);
          sendResponse({ ok: !!winner });
          break;
        }
        case "CC_BROADCAST_CLICK_PREV": {
          const tab = await resolveTab(sender);
          if (!tab || !tab.id) { sendResponse({ ok: false, error: "no-tab" }); break; }
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            world: "MAIN",
            func: clickPrevInFrame
          }).catch((e) => [{ result: { ok: false, error: String(e) } }]);
          const winner = (results || []).find((r) => r && r.result && r.result.ok);
          sendResponse({ ok: !!winner });
          break;
        }
        case "CC_CHECK_VERDICT": {
          const tab = await resolveTab(sender);
          if (!tab || !tab.id) { sendResponse({ ok: false }); break; }
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            world: "MAIN",
            func: checkVerdictInFrame
          }).catch(() => []);
          const res = (results || []).map(r => r && r.result).filter(Boolean);
          const passed = res.find(r => r.status === "passed");
          const failed = res.find(r => r.status === "failed");
          const running = res.find(r => r.status === "running");
          if (failed) sendResponse({ ok: true, verdict: "failed", output: failed.output });
          else if (passed) sendResponse({ ok: true, verdict: "passed" });
          else if (running) sendResponse({ ok: true, verdict: "running" });
          else sendResponse({ ok: true, verdict: "unknown" });
          break;
        }
        default:
          sendResponse({ ok: false, error: "Unknown message: " + msg.type });
      }
    } catch (err) {
      console.error("[CC background]", err);
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    }
  })();
  return true;
});

// ---------- Bundle builder ----------
function downloadBundle(problem) {
  const base = slugify(problem.code || problem.title || "problem");
  const md = renderMarkdown(problem);
  chrome.downloads.download({
    url: "data:text/markdown;charset=utf-8," + encodeURIComponent(md),
    filename: `${base}/problem.md`,
    conflictAction: "overwrite"
  });

  const samples = problem.samples || [];
  samples.forEach((s, i) => {
    chrome.downloads.download({
      url: "data:text/plain;charset=utf-8," + encodeURIComponent(s.input || ""),
      filename: `${base}/sample${i + 1}.in`,
      conflictAction: "overwrite"
    });
    chrome.downloads.download({
      url: "data:text/plain;charset=utf-8," + encodeURIComponent(s.output || ""),
      filename: `${base}/sample${i + 1}.out`,
      conflictAction: "overwrite"
    });
  });

  const solutions = problem.solutions || {};
  if (Object.keys(solutions).length) {
    for (const [lang, code] of Object.entries(solutions)) {
      if (!code || !code.trim()) continue;
      chrome.downloads.download({
        url: "data:text/plain;charset=utf-8," + encodeURIComponent(code),
        filename: `${base}/solution.${guessExt(lang)}`,
        conflictAction: "overwrite"
      });
    }
  } else {
    const ext = guessExt(problem.language);
    chrome.downloads.download({
      url: "data:text/plain;charset=utf-8," + encodeURIComponent(problem.solution || defaultTemplate(problem.language)),
      filename: `${base}/solution.${ext}`,
      conflictAction: "overwrite"
    });
  }
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "problem";
}
function guessExt(lang = "") {
  const l = String(lang).toLowerCase();
  if (l.includes("python")) return "py";
  if (l.includes("javascript") || l === "js") return "js";
  if (l.includes("java")) return "java";
  if (l.includes("cpp") || l.includes("c++")) return "cpp";
  return "txt";
}
function defaultTemplate(lang = "") {
  const l = String(lang).toLowerCase();
  if (l.includes("python")) return "# Write your solution here\n";
  if (l.includes("javascript") || l === "js") return "// Write your solution here\n";
  if (l.includes("java")) return "public class Main {\n  public static void main(String[] args) {\n  }\n}\n";
  if (l.includes("cpp") || l.includes("c++"))
    return "#include <bits/stdc++.h>\nusing namespace std;\nint main(){ios::sync_with_stdio(false);cin.tie(nullptr);return 0;}\n";
  return "";
}
function renderMarkdown(p) {
  const parts = [];
  parts.push(`# ${p.title || p.code || "Problem"}`);
  if (p.code) parts.push(`**Code:** \`${p.code}\``);
  if (p.url) parts.push(`**URL:** ${p.url}`);
  if (p.difficulty) parts.push(`**Difficulty:** ${p.difficulty}`);
  if (p.tags && p.tags.length) parts.push(`**Tags:** ${p.tags.join(", ")}`);
  parts.push(`**Status:** ${p.status || "unsolved"}`);
  parts.push("\n## Statement\n");
  parts.push(p.statement || "_(not captured)_");
  if (p.constraints) parts.push("\n## Constraints\n\n```\n" + p.constraints + "\n```");
  if (p.inputFormat) parts.push("\n## Input\n\n" + p.inputFormat);
  if (p.outputFormat) parts.push("\n## Output\n\n" + p.outputFormat);
  if (p.samples && p.samples.length) {
    parts.push("\n## Samples\n");
    p.samples.forEach((s, i) => {
      parts.push(`### Sample ${i + 1}\n`);
      parts.push("**Input**\n```\n" + (s.input || "") + "\n```");
      parts.push("**Output**\n```\n" + (s.output || "") + "\n```");
    });
  }
  if (p.notes) parts.push("\n## Notes\n\n" + p.notes);
  const sols = p.solutions && typeof p.solutions === "object" ? p.solutions : {};
  if (Object.keys(sols).length) {
    for (const [lang, code] of Object.entries(sols)) {
      if (code && code.trim()) parts.push(`\n## Solution (${lang})\n\n\`\`\`${lang}\n${code}\n\`\`\``);
    }
  } else if (p.solution) {
    parts.push("\n## Solution\n\n```" + (p.language || "") + "\n" + p.solution + "\n```");
  }
  return parts.join("\n");
}

// ---------- Editor injection (also runs inside frames) ----------
function injectIntoEditor(code) {
  try {
    // 1. Monaco Editor (via window.monaco in MAIN world)
    if (window.monaco && window.monaco.editor) {
      const models = (window.monaco.editor.getModels && window.monaco.editor.getModels()) || [];
      const editors = (window.monaco.editor.getEditors && window.monaco.editor.getEditors()) || [];

      // Identify active or code model
      let targetModel = null;
      let targetEditor = null;

      for (const ed of editors) {
        const m = ed.getModel && ed.getModel();
        if (m) {
          const u = (m.uri ? m.uri.toString() : "").toLowerCase();
          if (!/\.(csv|txt|json|in|out)$/.test(u)) {
            targetModel = m;
            targetEditor = ed;
            break;
          }
        }
      }

      if (!targetModel && models.length) {
        targetModel = models.find(m => {
          const u = (m.uri ? m.uri.toString() : "").toLowerCase();
          return !/\.(csv|txt|json|in|out)$/.test(u);
        }) || models[0];
      }

      if (targetModel) {
        // Completely replace model buffer
        targetModel.setValue(code);

        // Apply via active editor if available to update view and trigger change listeners
        if (targetEditor) {
          try {
            targetEditor.executeEdits("cc-companion", [{
              range: targetModel.getFullModelRange(),
              text: code,
              forceMoveMarkers: true
            }]);
            targetEditor.pushUndoStop();
            targetEditor.setPosition({ lineNumber: 1, column: 1 });
            targetEditor.focus();
          } catch {}
        }

        const lang = (targetModel.getLanguageId && targetModel.getLanguageId()) || "python";
        return { ok: true, kind: "monaco", language: lang };
      }
    }

    // 2. Monaco Editor DOM Fallback (when window.monaco is encapsulated)
    const monacoContainer = document.querySelector(".monaco-editor");
    if (monacoContainer) {
      const ta = monacoContainer.querySelector("textarea.inputarea, textarea");
      if (ta) {
        ta.focus();
        // Select all existing text
        ta.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA", keyCode: 65, which: 65, ctrlKey: true, bubbles: true, cancelable: true }));
        // Paste new code
        const dt = new DataTransfer();
        dt.setData("text/plain", code);
        const pasteEvt = new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: dt
        });
        ta.dispatchEvent(pasteEvt);
        return { ok: true, kind: "monaco-dom-paste", language: "python" };
      }
    }

    // 3. CodeMirror 5
    if (window.CodeMirror) {
      for (const n of document.querySelectorAll(".CodeMirror")) {
        if (n.CodeMirror && n.CodeMirror.setValue) {
          n.CodeMirror.setValue(code);
          n.CodeMirror.focus();
          return { ok: true, kind: "cm5" };
        }
      }
    }

    // 4. CodeMirror 6
    const cm6 = document.querySelector(".cm-editor");
    if (cm6) {
      cm6.focus();
      document.execCommand("selectAll");
      document.execCommand("insertText", false, code);
      return { ok: true, kind: "cm6" };
    }

    // 5. Standard Textarea (ONLY if NOT on a Monaco page)
    if (!monacoContainer) {
      const ta = document.querySelector("textarea");
      if (ta) {
        ta.focus();
        ta.value = "";
        ta.value = code;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        ta.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, kind: "textarea" };
      }
    }

    return { ok: false, error: "no-editor-found" };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

function getEditorContentInFrame() {
  try {
    if (window.monaco && window.monaco.editor) {
      const models = (window.monaco.editor.getModels && window.monaco.editor.getModels()) || [];
      const codeModel = models.find(m => {
        const lang = (m.getLanguageId && m.getLanguageId()) || "";
        const uri = (m.uri ? m.uri.toString() : "").toLowerCase();
        return (lang === "python" || lang === "cpp" || /\.(py|cpp|c|java|js|ts)$/.test(uri)) && !/\.(csv|txt|json)$/.test(uri);
      });
      if (codeModel && codeModel.getValue) {
        const val = codeModel.getValue();
        if (val && val.trim().length > 0) return { ok: true, content: val, kind: "monaco-model" };
      }
      const editors = (window.monaco.editor.getEditors && window.monaco.editor.getEditors()) || [];
      for (const ed of editors) {
        const m = ed.getModel && ed.getModel();
        if (m && m.getValue) {
          const val = m.getValue();
          if (val && val.trim().length > 0) return { ok: true, content: val, kind: "monaco-editor" };
        }
      }
    }
  } catch {}

  // Fallback 1: DOM Monaco view-lines
  try {
    const lines = document.querySelectorAll(".monaco-editor .view-lines .view-line");
    if (lines && lines.length > 0) {
      const text = Array.from(lines).map(l => l.innerText).join("\n");
      if (text && text.trim().length > 0) return { ok: true, content: text, kind: "dom-view-lines" };
    }
  } catch {}

  // Fallback 2: CodeMirror
  try {
    if (window.CodeMirror) {
      for (const n of document.querySelectorAll(".CodeMirror")) {
        if (n.CodeMirror && n.CodeMirror.getValue) {
          const val = n.CodeMirror.getValue();
          if (val && val.trim().length > 0) return { ok: true, content: val, kind: "cm5" };
        }
      }
    }
  } catch {}

  // Fallback 3: Plain Textarea (only if not a Monaco editor page)
  try {
    if (!document.querySelector(".monaco-editor")) {
      const ta = document.querySelector("textarea");
      if (ta && ta.value && ta.value.trim().length > 0) {
        return { ok: true, content: ta.value, kind: "textarea" };
      }
    }
  } catch {}

  return { ok: false, content: "" };
}

function probeEditorInFrame() {
  function findEditor() {
    if (window.monaco && window.monaco.editor) {
      const editors = (window.monaco.editor.getEditors && window.monaco.editor.getEditors()) || [];
      if (editors.length && editors[0].getModel) return { kind: "monaco", model: editors[0].getModel() };
      const models = window.monaco.editor.getModels();
      if (models && models.length) return { kind: "monaco", model: models[0] };
    }
    if (window.CodeMirror) {
      for (const n of document.querySelectorAll(".CodeMirror")) {
        if (n.CodeMirror) return { kind: "cm5", cm: n.CodeMirror };
      }
    }
    const cm6 = document.querySelector(".cm-editor");
    if (cm6) return { kind: "cm6", el: cm6 };
    const ta = document.querySelector("textarea.inputarea, textarea");
    if (ta) return { kind: "textarea", ta };
    return null;
  }
  const e = findEditor();
  if (!e) return { ok: false };
  let lang = null;
  try {
    if (e.kind === "monaco" && e.model && e.model.getLanguageId) lang = e.model.getLanguageId();
    if (e.kind === "cm5" && e.cm && e.cm.getOption) lang = e.cm.getOption("mode");
    if (!lang) {
      const sel = document.querySelector("select[name*='language' i], select[id*='language' i]");
      if (sel && sel.value) lang = sel.value;
    }
    if (!lang) {
      const fileTabs = document.querySelectorAll("[class*='tab'], [class*='file']");
      for (const t of fileTabs) {
        const m = (t.innerText || "").match(/\.(cpp|cc|cxx|py|java|js|ts)\b/i);
        if (m) { lang = m[1]; break; }
      }
    }
  } catch {}
  return { ok: true, kind: e.kind, language: lang };
}

function clickRunInFrame() {
  function tryRun(doc) {
    const runSelectors = [
      "button[data-cy*='run' i]",
      "[data-cy='run-btn']",
      "button.run-btn",
      "button[class*='RunBtn' i]",
      "button[class*='run-button' i]",
      "[title*='Run' i]"
    ];
    for (const sel of runSelectors) {
      const el = doc.querySelector(sel);
      if (el && el.offsetParent !== null && !el.disabled) { el.click(); return true; }
    }
    const buttons = Array.from(doc.querySelectorAll("button, [role='button'], a"));
    const targetBtn = buttons.find(btn => {
      if (btn.disabled || btn.offsetParent === null) return false;
      const text = (btn.innerText || btn.value || "").trim().toLowerCase();
      return text === "run" || text === "run code" || text.startsWith("run ");
    });
    if (targetBtn) { targetBtn.click(); return true; }
    return false;
  }
  if (tryRun(document)) return { ok: true, location: "main" };
  const frames = document.querySelectorAll("iframe");
  for (const f of frames) {
    try { if (f.contentDocument && tryRun(f.contentDocument)) return { ok: true, location: "iframe" }; } catch {}
  }
  return { ok: false, error: "run-not-found" };
}

function clickSubmitInFrame() {
  function trySubmit(doc) {
    const submitSelectors = [
      "button[data-cy*='submit' i]",
      "[data-cy='submit-btn']",
      "[data-cy='run-and-submit-btn']",
      "button.submit-btn",
      "button[class*='SubmitBtn' i]",
      "button[class*='submit-button' i]",
      "[title*='Submit' i]"
    ];
    for (const sel of submitSelectors) {
      const el = doc.querySelector(sel);
      if (el && el.offsetParent !== null && !el.disabled) { el.click(); return true; }
    }
    const buttons = Array.from(doc.querySelectorAll("button, [role='button'], a"));
    const targetBtn = buttons.find(btn => {
      if (btn.disabled || btn.offsetParent === null) return false;
      const text = (btn.innerText || btn.value || "").trim().toLowerCase();
      return text === "submit" || text === "submit code" || text.startsWith("submit ");
    });
    if (targetBtn) { targetBtn.click(); return true; }
    return false;
  }
  if (trySubmit(document)) return { ok: true, location: "main" };
  const frames = document.querySelectorAll("iframe");
  for (const f of frames) {
    try { if (f.contentDocument && trySubmit(f.contentDocument)) return { ok: true, location: "iframe" }; } catch {}
  }
  return { ok: false, error: "submit-not-found" };
}

function submitCodeInFrame() {
  return clickRunInFrame();
}

function clickNextInFrame() {
  function tryNext(doc) {
    const selectors = [
      "button[data-cy*='next' i]",
      "a[data-cy*='next' i]",
      "[data-cy='next-btn']",
      "[data-cy='continue-btn']",
      "button.next-btn",
      "a.next-btn",
      "button[class*='next' i]",
      "a[class*='next' i]",
      "button[class*='continue' i]",
      "a[class*='continue' i]"
    ];
    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      if (el && el.offsetParent !== null && !el.disabled) {
        el.click();
        return true;
      }
    }

    const buttons = Array.from(doc.querySelectorAll("button, a, [role='button']"));
    const nextBtn = buttons.find(b => {
      if (b.disabled || b.offsetParent === null) return false;
      const text = (b.innerText || b.value || "").trim().toLowerCase();
      return /^(next|next >|> next|continue|next problem|next exercise|next lesson|next question)$/i.test(text) || text.startsWith("next");
    });
    if (nextBtn) {
      nextBtn.click();
      return true;
    }
    return false;
  }

  if (tryNext(document)) return { ok: true, location: "main" };

  const frames = document.querySelectorAll("iframe");
  for (const f of frames) {
    try {
      if (f.contentDocument && tryNext(f.contentDocument)) {
        return { ok: true, location: "iframe" };
      }
    } catch {}
  }
  return { ok: false, error: "next-not-found" };
}

function clickPrevInFrame() {
  function tryPrev(doc) {
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
    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      if (el && el.offsetParent !== null && !el.disabled) {
        el.click();
        return true;
      }
    }

    const buttons = Array.from(doc.querySelectorAll("button, a, [role='button']"));
    const prevBtn = buttons.find(b => {
      if (b.disabled || b.offsetParent === null) return false;
      const text = (b.innerText || b.value || "").trim().toLowerCase();
      return /^(prev|< prev|previous|< previous|back)$/i.test(text) || text.startsWith("prev ") || text.startsWith("< prev");
    });
    if (prevBtn) {
      prevBtn.click();
      return true;
    }
    return false;
  }

  if (tryPrev(document)) return { ok: true, location: "main" };

  const frames = document.querySelectorAll("iframe");
  for (const f of frames) {
    try {
      if (f.contentDocument && tryPrev(f.contentDocument)) {
        return { ok: true, location: "iframe" };
      }
    } catch {}
  }
  return { ok: false, error: "prev-not-found" };
}

function checkVerdictInFrame() {
  function evaluate(doc) {
    const containers = doc.querySelectorAll("[class*='output' i], [class*='terminal' i], [class*='console' i], [class*='result' i], pre, .xterm");
    let combined = "";
    for (const c of containers) {
      combined += " " + (c.innerText || "");
    }
    const lower = combined.toLowerCase();

    // Check for running / judging state
    if (lower.includes("running...") || lower.includes("executing...") || lower.includes("judging...") || doc.querySelector("[class*='loading' i], [class*='spinner' i]")) {
      return { status: "running" };
    }

    // Check for explicit error / failed test cases
    const hasFailIcon = doc.querySelector("[class*='fail' i], [class*='wrong' i], [class*='cross' i], [data-cy*='fail' i], [aria-label*='failed' i]");
    const isError = lower.includes("wrong answer") ||
                    lower.includes("invalid syntax") ||
                    lower.includes("syntaxerror:") ||
                    lower.includes("nameerror:") ||
                    lower.includes("traceback (most recent call last)") ||
                    lower.includes("runtime error") ||
                    lower.includes("error:") ||
                    lower.includes("test cases failed") ||
                    lower.includes("failed ?") ||
                    lower.includes("did not pass") ||
                    hasFailIcon !== null;
    if (isError) {
      return { status: "failed", output: combined.slice(-250) };
    }

    // Check for explicit success / passed test cases
    const hasPassIcon = doc.querySelectorAll("[class*='pass' i], [class*='success' i], [class*='correct' i], [data-cy*='pass' i], [aria-label*='passed' i]");
    const isPassed = lower.includes("correct answer") ||
                     lower.includes("all test cases passed") ||
                     lower.includes("accepted") ||
                     lower.includes("100/100") ||
                     lower.includes("sample test cases passed") ||
                     lower.includes("passed all test cases") ||
                     (hasPassIcon.length > 0 && !isError);
    if (isPassed && !isError) {
      return { status: "passed" };
    }
    return null;
  }

  const mainRes = evaluate(document);
  if (mainRes) return mainRes;

  const frames = document.querySelectorAll("iframe");
  for (const f of frames) {
    try {
      if (f.contentDocument) {
        const frRes = evaluate(f.contentDocument);
        if (frRes) return frRes;
      }
    } catch {}
  }
  return { status: "unknown" };
}

// ---------- Keyboard shortcuts ----------
chrome.commands.onCommand.addListener(async (command) => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id || !/codechef\.com\/problems\//.test(tab.url || "")) return;

    if (command === "paste-clipboard-to-editor") {
      chrome.tabs.sendMessage(tab.id, { type: "CC_PASTE_CLIPBOARD" }).catch(() => {});
    } else if (command === "auto-paste-best") {
      chrome.tabs.sendMessage(tab.id, { type: "CC_AUTO_PASTE" }).catch(() => {});
    } else if (command === "ask-chatgpt") {
      chrome.tabs.sendMessage(tab.id, { type: "CC_ASK_CHATGPT" }).catch(() => {});
    } else if (command === "antigravity-solve") {
      chrome.tabs.sendMessage(tab.id, { type: "CC_ANTIGRAVITY_SOLVE" }).catch(() => {});
    }
  } catch (e) {
    console.warn("[CC] shortcut failed:", e);
  }
});
