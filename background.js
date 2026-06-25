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
  const isEligible = url && (url.includes(".poly.ai") || url.includes(".polyai.app"));
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

let offscreenPromise = null;

async function ensureOffscreen() {
  if (offscreenPromise) return offscreenPromise;

  offscreenPromise = (async () => {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    if (contexts.length > 0) return;

    try {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["WORKERS"],
        justification: "Run Bergamot WASM translation engine",
      });
    } catch (err) {
      throw new Error(
        `Could not start translation engine: ${err.message} — reload the extension in chrome://extensions`
      );
    }
  })();

  await offscreenPromise;
  offscreenPromise = null;
}

async function waitForOffscreenReady(maxAttempts = 20) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "bergamot-ping",
      });
      if (response?.ready) return;
    } catch {
      // Offscreen scripts may still be loading.
    }
    await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
  }

  throw new Error(
    "Translation engine did not start — reload this page and try again"
  );
}

async function forwardToOffscreen(message) {
  await ensureOffscreen();
  await waitForOffscreenReady();

  try {
    return await chrome.runtime.sendMessage({
      ...message,
      type: "bergamot-translate",
    });
  } catch (err) {
    const msg = err?.message || String(err);
    if (msg.includes("Receiving end does not exist")) {
      throw new Error(
        "Translation engine unavailable — reload this page and try again"
      );
    }
    throw new Error(`Could not reach translation engine: ${msg}`);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "translate" || !sender.tab) return;

  forwardToOffscreen(message)
    .then((response) => {
      if (!response) {
        sendResponse({
          error:
            "Translation engine returned no response — reload this page and try again",
        });
        return;
      }
      sendResponse(response);
    })
    .catch((err) => sendResponse({ error: err.message }));

  return true;
});
