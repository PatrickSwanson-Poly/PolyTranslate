(function () {
  "use strict";

  console.log("[PolyTranslate] Content script loaded on", window.location.href);

  const TRANSLATE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8l6 6"/><path d="M4 14l6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="M22 22l-5-10-5 10"/><path d="M14 18h6"/></svg>`;

  let conversationTranslateActive = false;
  const originalTexts = new WeakMap();

  // ── Language settings (persisted to chrome.storage) ──

  let sourceLang = POLYTRANSLATE_CONFIG.DEFAULT_SOURCE_LANG;
  let targetLang = POLYTRANSLATE_CONFIG.DEFAULT_TARGET_LANG;
  let inputSourceLang = POLYTRANSLATE_CONFIG.DEFAULT_INPUT_SOURCE_LANG;
  let inputTargetLang = POLYTRANSLATE_CONFIG.DEFAULT_INPUT_TARGET_LANG;
  let installedLangs = null;

  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(
        ["pt_source", "pt_target", "pt_input_source", "pt_input_target"],
        (result) => {
          if (result.pt_source && result.pt_source !== "auto")
            sourceLang = result.pt_source;
          if (result.pt_target) targetLang = result.pt_target;
          if (result.pt_input_source && result.pt_input_source !== "auto")
            inputSourceLang = result.pt_input_source;
          if (result.pt_input_target) inputTargetLang = result.pt_input_target;
          resolve();
        }
      );
    });
  }

  function saveSetting(key, value) {
    chrome.storage.local.set({ [key]: value });
  }

  function langName(code) {
    const lang = PT_LANGUAGES.find((l) => l.code === code);
    return lang ? lang.name : code.toUpperCase();
  }

  function buildSelect(selectedCode) {
    const select = document.createElement("select");
    select.className = "pt-lang-select";
    const available = installedLangs
      ? PT_LANGUAGES.filter(
          (l) => l.code === "en" || installedLangs.includes(l.code)
        )
      : PT_LANGUAGES;
    available.forEach((lang) => {
      const opt = document.createElement("option");
      opt.value = lang.code;
      opt.textContent = lang.name;
      if (lang.code === selectedCode) opt.selected = true;
      select.appendChild(opt);
    });
    return select;
  }

  // ── Feature 1: Conversation page translator ──

  let toolbarVisible = false;

  function createConversationToolbar() {
    if (document.querySelector(".pt-sidebar-item")) return;

    // Clean up orphaned popovers left behind by SPA re-renders
    document.querySelectorAll(".pt-toolbar-popover").forEach((el) => el.remove());

    const footerUl = document.querySelector('[data-sidebar="footer"] ul');
    if (!footerUl) return;

    // Sidebar menu item
    const li = document.createElement("li");
    li.className = "pt-sidebar-item group/menu-item relative";
    li.setAttribute("data-sidebar", "menu-item");

    const menuBtn = document.createElement("a");
    menuBtn.className =
      "peer/menu-button flex w-full items-center gap-xs2 overflow-hidden rounded-xSmall px-xs3 py-xs2 text-left outline-none ring-sidebar-ring transition-[width,height,padding] [&>span:last-child]:truncate [&_svg]:shrink-0 group-data-[collapsible=icon]:[&_svg]:size-[20px] group-data-[collapsible=icon]:size-[40px] group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0 text-body-regular [&_svg]:size-[20px] group-data-[collapsible=icon]:!justify-start group-data-[collapsible=icon]:!w-full group-data-[collapsible=icon]:!px-xs3 group-data-[collapsible=icon]:!h-[36px] h-[36px]";
    menuBtn.setAttribute("data-sidebar", "menu-button");
    menuBtn.setAttribute("data-size", "medium");
    menuBtn.style.cursor = "pointer";
    const logoUrl = chrome.runtime.getURL("icons/icon48.png");
    menuBtn.innerHTML = `
      <img src="${logoUrl}" width="20" height="20" style="border-radius:4px;flex-shrink:0;" />
      <span class="truncate group-data-[collapsible=icon]:hidden">PolyTranslate</span>`;

    menuBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    menuBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toolbarVisible = !toolbarVisible;
      const popover = document.querySelector(".pt-toolbar-popover");
      if (popover) {
        if (toolbarVisible) {
          const rect = li.getBoundingClientRect();
          popover.style.left = rect.right + 8 + "px";
        }
        popover.classList.toggle("pt-toolbar-popover-visible", toolbarVisible);
      }
    });

    li.setAttribute("data-side-panel-ignore-outside-click", "true");
    li.addEventListener("mousedown", (e) => e.stopPropagation());
    li.appendChild(menuBtn);
    footerUl.insertBefore(li, footerUl.firstChild);

    // Popover toolbar
    const popover = document.createElement("div");
    popover.className = "pt-toolbar-popover";
    popover.setAttribute("data-side-panel-ignore-outside-click", "true");
    popover.addEventListener("mousedown", (e) => e.stopPropagation());
    popover.addEventListener("click", (e) => e.stopPropagation());

    const srcSelect = buildSelect(sourceLang);
    srcSelect.addEventListener("change", (e) => {
      sourceLang = e.target.value;
      saveSetting("pt_source", sourceLang);
    });

    const arrow = document.createElement("span");
    arrow.className = "pt-lang-arrow";
    arrow.textContent = "→";

    const tgtSelect = buildSelect(targetLang);
    tgtSelect.addEventListener("change", async (e) => {
      targetLang = e.target.value;
      saveSetting("pt_target", targetLang);
      updateBadgeContent();
      if (conversationTranslateActive) {
        restoreConversationTurns();
        const btn = document.querySelector(".pt-toolbar-popover .pt-toggle-btn");
        if (btn) btn.innerHTML = `<span class="pt-spinner"></span> Translating…`;
        await translateConversationTurns();
        if (btn) btn.innerHTML = `${TRANSLATE_ICON} Live`;
      }
    });

    const btn = document.createElement("button");
    btn.className = "pt-toggle-btn";
    btn.innerHTML = `${TRANSLATE_ICON} Translate`;
    btn.title = "Translate transcript turns";
    btn.addEventListener("click", toggleConversationTranslation);

    popover.appendChild(srcSelect);
    popover.appendChild(arrow);
    popover.appendChild(tgtSelect);
    popover.appendChild(btn);

    document.body.appendChild(popover);

    // Close popover when clicking outside
    document.addEventListener("click", (e) => {
      if (
        toolbarVisible &&
        !popover.contains(e.target) &&
        !li.contains(e.target)
      ) {
        toolbarVisible = false;
        popover.classList.remove("pt-toolbar-popover-visible");
      }
    });
  }

  function updateBadgeContent() {
    const badge = targetLang.toUpperCase();
    document.documentElement.style.setProperty("--pt-badge", `"${badge}"`);
  }

  function resetTranslateButton() {
    conversationTranslateActive = false;
    const btn = document.querySelector(".pt-toolbar-popover .pt-toggle-btn");
    if (btn) {
      btn.classList.remove("pt-active");
      btn.innerHTML = `${TRANSLATE_ICON} Translate`;
    }
  }

  let panelObserver = null;
  let liveTranslateDebounce = null;

  function translateNewSpans() {
    if (liveTranslateDebounce) return;
    liveTranslateDebounce = setTimeout(async () => {
      liveTranslateDebounce = null;
      if (!conversationTranslateActive) return;

      const spans = getConversationTurnSpans().filter(
        (s) => !originalTexts.has(s) && !s.classList.contains("pt-translated")
      );
      if (spans.length === 0) return;

      const texts = spans.map((s) => s.textContent);
      spans.forEach((s) => originalTexts.set(s, s.textContent));

      try {
        const translated = await translateBatch(texts, sourceLang, targetLang);
        spans.forEach((span, i) => {
          if (translated[i].trim() === texts[i].trim()) return;
          span.textContent = translated[i];
          span.classList.add("pt-translated");
        });
      } catch (err) {
        console.error("[PolyTranslate] Live translate failed:", err);
      }
    }, 300);
  }

  function watchPanels() {
    if (panelObserver) {
      panelObserver.disconnect();
      panelObserver = null;
    }

    const targets = [
      document.querySelector("#conversation-review"),
      document.querySelector("#chat-panel"),
    ].filter(Boolean);

    if (targets.length === 0) return;

    panelObserver = new MutationObserver(() => {
      if (conversationTranslateActive) {
        translateNewSpans();
      }
    });

    targets.forEach((t) =>
      panelObserver.observe(t, { childList: true, subtree: true })
    );
  }

  function stopWatchingPanels() {
    if (panelObserver) {
      panelObserver.disconnect();
      panelObserver = null;
    }
  }

  async function toggleConversationTranslation() {
    const btn = document.querySelector(".pt-toolbar-popover .pt-toggle-btn");
    conversationTranslateActive = !conversationTranslateActive;
    btn.classList.toggle("pt-active", conversationTranslateActive);

    if (conversationTranslateActive) {
      btn.innerHTML = `<span class="pt-spinner"></span> Translating…`;
      await translateConversationTurns();
      btn.innerHTML = `${TRANSLATE_ICON} Live`;
      watchPanels();
    } else {
      stopWatchingPanels();
      restoreConversationTurns();
      btn.innerHTML = `${TRANSLATE_ICON} Translate`;
    }
  }

  function getConversationTurnSpans() {
    const spans = [];

    // Conversation review panel turns
    document.querySelectorAll("[data-turn-idx]").forEach((turn) => {
      turn.querySelectorAll("span.whitespace-pre-wrap").forEach((span) => {
        if (span.textContent.trim().length > 0) {
          spans.push(span);
        }
      });
    });

    // Live chat message bubbles — avoid brittle styled-components hashes;
    // walk up from the test-id anchor to find the first text-bearing child
    document.querySelectorAll('[data-test-id="chatMessages"] [data-test-id="chat-message-text"]').forEach((bubble) => {
      const textEl =
        bubble.querySelector("[class*='MessageText']") ||
        bubble.querySelector("div.gzGCB") ||
        bubble.querySelector(".sc-erUUZj") ||
        bubble.querySelector("div");
      if (textEl && textEl.textContent.trim().length > 0 && !spans.includes(textEl)) {
        spans.push(textEl);
      }
    });

    return spans;
  }

  async function translateConversationTurns() {
    const spans = getConversationTurnSpans();
    if (spans.length === 0) return;

    const texts = spans.map((s) => s.textContent);
    spans.forEach((s) => originalTexts.set(s, s.textContent));

    try {
      const translated = await translateBatch(texts, sourceLang, targetLang);
      spans.forEach((span, i) => {
        if (translated[i].trim() === texts[i].trim()) return;
        span.textContent = translated[i];
        span.classList.add("pt-translated");
      });
    } catch (err) {
      console.error("[PolyTranslate] Conversation translation failed:", err);
      alert("Translation failed — see console for details.");
    }
  }

  function restoreConversationTurns() {
    const spans = getConversationTurnSpans();
    spans.forEach((span) => {
      const original = originalTexts.get(span);
      if (original) {
        span.textContent = original;
        span.classList.remove("pt-translated", "pt-has-original");
      }
    });
  }

  // ── Feature 3: Input auto-translator ──

  function createInputTranslateButton() {
    const textarea = document.querySelector("#chat-panel textarea");
    if (!textarea || textarea.dataset.ptBound) return;

    // Clean up orphaned anchors from previous textarea instances
    document.querySelectorAll(".pt-input-anchor").forEach((el) => el.remove());

    textarea.dataset.ptBound = "true";

    const wrapper = textarea.closest(".dAvboU") || textarea.closest("div");
    if (!wrapper) return;

    // Translate popover container (anchored to wrapper)
    const anchor = document.createElement("div");
    anchor.className = "pt-input-anchor";
    anchor.setAttribute("data-side-panel-ignore-outside-click", "true");
    anchor.addEventListener("mousedown", (e) => e.stopPropagation());
    anchor.addEventListener("click", (e) => e.stopPropagation());

    const logoUrl = chrome.runtime.getURL("icons/icon48.png");
    const circleBtn = document.createElement("button");
    circleBtn.className = "pt-input-circle-btn";
    circleBtn.setAttribute("data-pt-tooltip",
      navigator.platform.includes("Mac") ? "Translate ⌘⇧Y" : "Translate Ctrl+Shift+Y"
    );
    circleBtn.innerHTML = `<img src="${logoUrl}" width="20" height="20">`;

    const popup = document.createElement("div");
    popup.className = "pt-input-popup";

    const srcSelect = buildSelect(inputSourceLang);
    srcSelect.className = "pt-lang-select pt-lang-select-sm";
    srcSelect.addEventListener("change", (e) => {
      inputSourceLang = e.target.value;
      saveSetting("pt_input_source", inputSourceLang);
    });

    const inputArrow = document.createElement("span");
    inputArrow.className = "pt-lang-arrow-sm";
    inputArrow.textContent = "→";

    const tgtSelect = buildSelect(inputTargetLang);
    tgtSelect.className = "pt-lang-select pt-lang-select-sm";
    tgtSelect.addEventListener("change", (e) => {
      inputTargetLang = e.target.value;
      saveSetting("pt_input_target", inputTargetLang);
    });

    const goBtn = document.createElement("button");
    goBtn.className = "pt-input-go-btn";
    goBtn.textContent = "Translate";
    goBtn.addEventListener("click", () => {
      popup.classList.remove("pt-input-popup-visible");
      translateInput(textarea);
    });

    popup.appendChild(srcSelect);
    popup.appendChild(inputArrow);
    popup.appendChild(tgtSelect);
    popup.appendChild(goBtn);

    function updateCircleDim() {
      circleBtn.classList.toggle("pt-input-circle-dim", !textarea.value.trim());
    }
    textarea.addEventListener("input", updateCircleDim);
    updateCircleDim();

    circleBtn.addEventListener("click", () => {
      popup.classList.toggle("pt-input-popup-visible");
    });

    document.addEventListener("click", (e) => {
      if (
        popup.classList.contains("pt-input-popup-visible") &&
        !popup.contains(e.target) &&
        !circleBtn.contains(e.target)
      ) {
        popup.classList.remove("pt-input-popup-visible");
      }
    });

    anchor.appendChild(popup);
    anchor.appendChild(circleBtn);
    wrapper.appendChild(anchor);

    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        e.stopPropagation();
        const activeTextarea = document.querySelector(
          "#chat-panel textarea"
        );
        if (activeTextarea && activeTextarea.value.trim()) {
          translateInput(activeTextarea);
        }
      }
    }, true);
  }

  function resetInputBtn() {
    const btn = document.querySelector(".pt-input-circle-btn");
    if (btn) {
      const logoUrl = chrome.runtime.getURL("icons/icon48.png");
      btn.innerHTML = `<img src="${logoUrl}" width="20" height="20">`;
    }
  }

  async function translateInput(textarea) {
    const text = textarea.value.trim();
    if (!text) return;

    const circleEl = document.querySelector(".pt-input-circle-btn");
    if (circleEl) circleEl.innerHTML = `<span class="pt-spinner"></span>`;

    try {
      const translated = await translateText(
        text,
        inputSourceLang,
        inputTargetLang
      );

      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      ).set;
      nativeSetter.call(textarea, translated);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
      textarea.focus();
    } catch (err) {
      console.error("[PolyTranslate] Input translation failed:", err);
    } finally {
      resetInputBtn();
    }
  }

  // ── Initialization ──

  async function init() {
    await loadSettings();

    try {
      const url = chrome.runtime.getURL("installed-languages.json");
      const resp = await fetch(url);
      if (resp.ok) installedLangs = await resp.json();
    } catch {
      // File missing — show all languages
    }

    updateBadgeContent();
    createConversationToolbar();
    createInputTranslateButton();
  }

  let pageObserverDebounce = null;
  const pageObserver = new MutationObserver(() => {
    if (!chrome.runtime?.id) {
      pageObserver.disconnect();
      return;
    }
    if (pageObserverDebounce) return;
    pageObserverDebounce = setTimeout(() => {
      pageObserverDebounce = null;
      createConversationToolbar();
      createInputTranslateButton();

      // Re-attach panel watcher if live translation is on but targets were replaced
      if (conversationTranslateActive) {
        watchPanels();
      }
    }, 200);
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      init();
      pageObserver.observe(document.body, { childList: true, subtree: true });
    });
  } else {
    init();
    pageObserver.observe(document.body, { childList: true, subtree: true });
  }
})();
