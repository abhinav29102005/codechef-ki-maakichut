// editor-bridge.js — runs inside every CodeChef frame (MAIN world)
(function () {
  function findEditor() {
    if (window.monaco && window.monaco.editor) {
      const editors = (window.monaco.editor.getEditors && window.monaco.editor.getEditors()) || [];
      if (editors.length) {
        for (const ed of editors) {
          const m = ed.getModel && ed.getModel();
          if (m) {
            const u = (m.uri ? m.uri.toString() : "").toLowerCase();
            if (/\.(py|cpp|c|java|js|ts)$/.test(u) || (!/\.(csv|txt|json|in|out)$/.test(u) && ed.hasWidgetFocus && ed.hasWidgetFocus())) {
              return { kind: "monaco", model: m, editor: ed, api: window.monaco };
            }
          }
        }
        const active = editors.find(ed => ed.getModel && ed.getModel());
        if (active) return { kind: "monaco", model: active.getModel(), editor: active, api: window.monaco };
      }

      const models = (window.monaco.editor.getModels && window.monaco.editor.getModels()) || [];
      if (models.length) {
        const codeModel = models.find(m => {
          const u = (m.uri ? m.uri.toString() : "").toLowerCase();
          return /\.(py|cpp|c|java|js|ts)$/.test(u) && !/\.(csv|txt|json)$/.test(u);
        });
        return { kind: "monaco", model: codeModel || models[0], api: window.monaco };
      }
    }
    if (window.CodeMirror) {
      for (const n of document.querySelectorAll(".CodeMirror")) {
        if (n.CodeMirror) return { kind: "cm5", cm: n.CodeMirror };
      }
    }
    const cm6 = document.querySelector(".cm-editor");
    if (cm6) return { kind: "cm6", el: cm6 };
    const ta = document.querySelector(".monaco-editor textarea, textarea.inputarea, textarea");
    if (ta) return { kind: "textarea", ta };
    return null;
  }

  function detectLanguage(editor) {
    try {
      if (editor && editor.kind === "monaco" && editor.model) {
        const id = editor.model.getLanguageId && editor.model.getLanguageId();
        if (id) return normalize(id);
      }
      if (editor && editor.kind === "cm5" && editor.cm) {
        const mode = editor.cm.getOption && editor.cm.getOption("mode");
        if (mode) return normalize(String(mode));
      }
      const sels = [
        "select[name*='language' i]",
        "select[id*='language' i]",
        "[class*='language'] select",
        "[data-cy*='language'] select"
      ];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && el.value) return normalize(el.value);
        if (el && el.options && el.selectedIndex >= 0) {
          const opt = el.options[el.selectedIndex];
          const label = (opt && (opt.text || opt.label)) || "";
          const n = normalize(label);
          if (n) return n;
        }
      }
      const fileTabs = document.querySelectorAll("[class*='tab'], [class*='file']");
      for (const t of fileTabs) {
        const m = (t.innerText || "").match(/\.(cpp|cc|cxx|py|java|js|ts)\b/i);
        if (m) return normalize(m[1]);
      }
    } catch {}
    return null;
  }

  function normalize(str) {
    const s = String(str).toLowerCase();
    if (s.includes("cpp") || s.includes("c++") || s === "cc" || s === "cxx") return "cpp";
    if (s.includes("python") || s === "py") return "python";
    if (s.includes("java") && !s.includes("javascript")) return "java";
    if (s.includes("javascript") || s === "js" || s === "ts" || s.includes("typescript")) return "javascript";
    return null;
  }

  function inject(code) {
    const e = findEditor();
    if (!e) return { ok: false, error: "no-editor" };
    try {
      if (e.kind === "monaco") {
        if (e.editor && e.editor.setValue) {
          e.editor.setValue(code);
          e.editor.focus();
        } else if (e.model && e.model.setValue) {
          e.model.setValue(code);
        }
        if (e.api && e.api.editor && e.api.editor.getEditors) {
          const eds = e.api.editor.getEditors();
          if (eds && eds[0]) {
            try {
              const lc = e.model.getLineCount();
              eds[0].setPosition({ lineNumber: lc, column: e.model.getLineMaxColumn(lc) });
              eds[0].focus();
            } catch {}
          }
        }
      } else if (e.kind === "cm5") {
        e.cm.setValue(code); e.cm.focus();
      } else if (e.kind === "cm6") {
        e.el.focus();
        document.execCommand("selectAll");
        document.execCommand("insertText", false, code);
      } else if (e.kind === "textarea") {
        e.ta.focus(); e.ta.value = code;
        e.ta.dispatchEvent(new Event("input", { bubbles: true }));
        e.ta.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return { ok: true, kind: e.kind, language: detectLanguage(e) };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  }

  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.onMessage) return;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "CC_INJECT_CODE_IN_FRAME") {
      if (!findEditor()) { sendResponse({ ok: false, error: "no-editor" }); return false; }
      sendResponse(inject(msg.code));
      return true;
    }
    if (msg.type === "CC_PROBE_EDITOR") {
      const e = findEditor();
      sendResponse({
        ok: !!e,
        kind: e ? e.kind : null,
        language: e ? detectLanguage(e) : null
      });
      return true;
    }
  });
})();
