const $ = (s) => document.querySelector(s);
const status = $("#status");

function flash(msg, isError = false) {
  if (!status) return;
  status.textContent = msg;
  status.style.color = isError ? "#dc2626" : "#059669";
  clearTimeout(flash._t);
  flash._t = setTimeout(() => {
    if (status) status.textContent = "";
  }, 3200);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function requireCodeChefTab() {
  const tab = await activeTab();
  if (!tab || !/codechef\.com/.test(tab.url || "")) {
    throw new Error("Open a CodeChef page first.");
  }
  return tab;
}

async function sendToTab(msg) {
  const tab = await requireCodeChefTab();
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (e) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] }).catch(() => {});
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, world: "MAIN", files: ["editor-bridge.js"] }).catch(() => {});
      await new Promise(r => setTimeout(r, 200));
      return await chrome.tabs.sendMessage(tab.id, msg);
    } catch (err2) {
      throw new Error("Please reload the CodeChef page to connect the script.");
    }
  }
}

// Check auto-advance state on open
(async () => {
  try {
    const tab = await activeTab();
    if (tab && tab.id && /codechef\.com/.test(tab.url || "")) {
      const r = await sendToTab({ type: "CC_GET_AUTO_STATUS" }).catch(() => null);
      if (r && r.active) {
        $("#auto-advance").style.display = "none";
        $("#stop-auto").style.display = "block";
        flash("🚀 Auto-advance active!");
      }
    }
  } catch {}
})();

// Auto-advance
$("#auto-advance").onclick = async () => {
  try {
    flash("🚀 Starting auto-course solver…");
    $("#auto-advance").style.display = "none";
    $("#stop-auto").style.display = "block";
    const r = await sendToTab({ type: "CC_AUTO_COMPLETE" });
    if (r && r.ok === false) throw new Error(r.error || "Failed to start");
    flash("🚀 Auto-advance running! Waiting for test pass…");
  } catch (e) {
    $("#auto-advance").style.display = "block";
    $("#stop-auto").style.display = "none";
    flash(e.message, true);
  }
};

$("#stop-auto").onclick = async () => {
  try {
    $("#stop-auto").style.display = "none";
    $("#auto-advance").style.display = "block";
    flash("⏹️ Auto-advance stopped.");
    await sendToTab({ type: "CC_STOP_AUTO" });
  } catch (e) {
    flash(e.message, true);
  }
};

// Antigravity solve
$("#antigravity-solve").onclick = async () => {
  try {
    flash("⚡ Analyzing code & solving…");
    const r = await sendToTab({ type: "CC_ANTIGRAVITY_SOLVE" });
    if (r && r.ok === false) throw new Error(r.error || "Failed");
    if (r.submitted) flash("✅ Solved & Executed!");
    else flash("Injected! Please click Run.");
  } catch (e) { flash(e.message, true); }
};

// Navigation & Run
$("#nav-prev").onclick = async () => {
  try {
    flash("⏮️ Navigating to previous…");
    await sendToTab({ type: "CC_CLICK_PREV" });
  } catch (e) { flash(e.message, true); }
};

$("#run-code").onclick = async () => {
  try {
    flash("▶ Executing Run / Submit…");
    const r = await sendToTab({ type: "CC_RUN_CODE" });
    if (r && r.ok === false) throw new Error(r.error || "Run button not found");
    flash("▶ Run triggered!");
  } catch (e) { flash(e.message, true); }
};

$("#nav-next").onclick = async () => {
  try {
    flash("⏭️ Navigating to next…");
    await sendToTab({ type: "CC_CLICK_NEXT" });
  } catch (e) { flash(e.message, true); }
};

// Utilities
$("#toggle-toolbar").onclick = async () => {
  try {
    flash("📌 Toggling in-page toolbar…");
    await sendToTab({ type: "CC_TOGGLE_TOOLBAR" });
  } catch (e) { flash(e.message, true); }
};

$("#paste-clipboard").onclick = async () => {
  try {
    const r = await sendToTab({ type: "CC_PASTE_CLIPBOARD" });
    if (r && r.ok === false) throw new Error(r.error || "Paste failed");
    flash(`Pasted into editor (${r.kind || "editor"}).`);
  } catch (e) { flash(e.message, true); }
};

$("#ask-chatgpt").onclick = async () => {
  try {
    const r = await sendToTab({ type: "CC_ASK_CHATGPT" });
    if (r && r.ok === false) throw new Error(r.error || "Failed");
    if (r.mode === "web") flash("Opened ChatGPT — press Enter there.");
    else flash(`AI solution pasted (${r.model}).`);
  } catch (e) { flash(e.message, true); }
};

$("#copy-all").onclick = async () => {
  try {
    const r = await sendToTab({ type: "CC_COPY_ALL" });
    if (r && r.ok === false) throw new Error(r.error || "Copy failed");
    flash("Problem copied to clipboard!");
  } catch (e) { flash(e.message, true); }
};

$("#save").onclick = async () => {
  try {
    const r = await sendToTab({ type: "CC_SCRAPE_NOW" });
    if (!r || !r.problem) throw new Error("Could not scrape page.");
    const res = await chrome.runtime.sendMessage({ type: "CC_SAVE_PROBLEM", problem: r.problem });
    if (res.ok) flash(`Saved (#${res.record.id}).`);
    else flash("Save failed: " + res.error, true);
  } catch (e) { flash(e.message, true); }
};

$("#search-github").onclick = async () => {
  try {
    const r = await sendToTab({ type: "CC_SEARCH_GITHUB" });
    if (r && r.ok === false) throw new Error(r.error || "Failed");
    flash("Opened GitHub search.");
  } catch (e) { flash(e.message, true); }
};

$("#open-library").onclick = () => {
  chrome.runtime.sendMessage({ type: "CC_OPEN_LIBRARY" });
  window.close();
};

$("#open-settings").onclick = (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
  window.close();
};

// Reload helpers
$("#reload-page").onclick = async () => {
  try {
    const tab = await activeTab();
    if (tab?.id) {
      flash("🔄 Reloading page…");
      chrome.tabs.reload(tab.id);
    }
  } catch (e) { flash(e.message, true); }
};

$("#reload-extension").onclick = () => {
  flash("⚡ Reloading extension…");
  chrome.runtime.reload();
};
