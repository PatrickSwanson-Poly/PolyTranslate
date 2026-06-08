const COLOR_ICONS = {
  16: "icons/icon16.png",
  48: "icons/icon48.png",
  128: "icons/icon128.png",
};

const BW_ICONS = {
  16: "icons/icon16_bw.png",
  48: "icons/icon48_bw.png",
  128: "icons/icon128_bw.png",
};

function updateIcon(tabId, url) {
  const isEligible = url && url.includes(".poly.ai");
  chrome.action.setIcon({
    tabId,
    path: isEligible ? COLOR_ICONS : BW_ICONS,
  });
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId);
  updateIcon(tabId, tab.url);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    updateIcon(tabId, tab.url);
  }
});

// ── Offscreen document for Bergamot WASM translation ──

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["WORKERS"],
    justification: "Run Bergamot WASM translation engine",
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "translate" || !sender.tab) return;

  ensureOffscreen()
    .then(() =>
      chrome.runtime.sendMessage({ ...message, type: "bergamot-translate" })
    )
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err.message }));

  return true;
});
