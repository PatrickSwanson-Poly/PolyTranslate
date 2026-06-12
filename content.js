(function () {
  "use strict";

  console.log("[PolyTranslate] Content script loaded on", window.location.href);

  const TRANSLATE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8l6 6"/><path d="M4 14l6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="M22 22l-5-10-5 10"/><path d="M14 18h6"/></svg>`;

  const LANG_ABBR = {
    es: "ES", en: "EN", zh: "ZH", ja: "JA", ko: "KO", pt: "PT",
    ar: "AR", fr: "FR", de: "DE", it: "IT", nl: "NL", ru: "RU",
    pl: "PL", sv: "SV", da: "DA", no: "NO", fi: "FI", he: "HE",
    hi: "HI", th: "TH", vi: "VI", uk: "UK", ro: "RO", el: "EL",
    sr: "SR",
  };

  let conversationTranslateActive = false;
  const originalTexts = new WeakMap();
  const LOGO_OK = chrome.runtime.getURL("icons/icon48.png");
  const LOGO_ERR = chrome.runtime.getURL("icons/icon48_err.png");

  function setErrorState(on) {
    document.querySelectorAll(".pt-translate-toggle img, .pt-input-circle-btn img").forEach((img) => {
      img.src = on ? LOGO_ERR : LOGO_OK;
    });
  }

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

  function langAbbr(code) {
    return LANG_ABBR[code] || code.toUpperCase();
  }

  function langPairLabel() {
    return `${langAbbr(sourceLang)} → ${langAbbr(targetLang)}`;
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

  function updateLangLabel() {
    document.querySelectorAll(".pt-translate-lang-label").forEach((label) => {
      label.textContent = langPairLabel();
    });
  }

  function setTranslateSplitActive(on) {
    document.querySelectorAll(".pt-translate-split").forEach((split) => {
      split.classList.toggle("pt-split-active", on);
    });
  }

  function setToggleIcon(btn, html) {
    const icon = btn.querySelector(".pt-translate-toggle-icon");
    if (icon) icon.innerHTML = html;
  }

  function attachTranslateTooltip(btn) {
    if (btn.querySelector(".pt-translate-tooltip")) return;

    const tooltip = document.createElement("span");
    tooltip.className = "pt-translate-tooltip";
    tooltip.setAttribute("aria-hidden", "true");
    tooltip.innerHTML =
      '<span class="pt-translate-tooltip-label">Translate</span>' +
      '<svg class="pt-translate-tooltip-caret" fill="#161617" aria-hidden="true" width="10" height="10" viewBox="0 0 10 10">' +
      '<path stroke="none" d="M0,0 H10 L6.25,3.75 Q5,5 3.75,3.75 Z"></path></svg>';
    btn.appendChild(tooltip);
    btn.addEventListener("mouseenter", () => {
      tooltip.classList.add("pt-translate-tooltip-visible");
    });
    btn.addEventListener("mouseleave", () => {
      tooltip.classList.remove("pt-translate-tooltip-visible");
    });
  }

  function setTranslateToggleIdle() {
    setTranslateSplitActive(false);
    document.querySelectorAll(".pt-translate-toggle").forEach((btn) => {
      btn.classList.remove("pt-active");
      setToggleIcon(btn, TRANSLATE_ICON);
      attachTranslateTooltip(btn);
      btn.setAttribute("aria-label", "Translate transcript");
    });
  }

  function setTranslateToggleLoading() {
    document.querySelectorAll(".pt-translate-toggle").forEach((btn) => {
      setToggleIcon(btn, `<span class="pt-spinner"></span>`);
      attachTranslateTooltip(btn);
    });
  }

  function setTranslateToggleActive() {
    setTranslateSplitActive(true);
    document.querySelectorAll(".pt-translate-toggle").forEach((btn) => {
      btn.classList.add("pt-active");
      setToggleIcon(btn, TRANSLATE_ICON);
      attachTranslateTooltip(btn);
      btn.setAttribute("aria-label", "Translation active");
    });
  }

  function updateBadgeContent() {
    const badge = langAbbr(targetLang);
    document.documentElement.style.setProperty("--pt-badge", `"${badge}"`);
  }

  // ── Feature 1: Transcript translate button (new UI) ──

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getTranscriptPanel(turn) {
    return (
      turn.closest("#conversation-review") ||
      turn.closest("[role='tabpanel']") ||
      turn.closest("main") ||
      turn.closest("aside") ||
      turn.closest("[data-side-panel]") ||
      turn.closest("[role='dialog']") ||
      turn.parentElement?.parentElement?.parentElement
    );
  }

  function getTranscriptPanels() {
    const panels = new Set();
    [...document.querySelectorAll("[data-turn-idx]")].forEach((turn) => {
      if (!isVisible(turn)) return;
      const panel = getTranscriptPanel(turn);
      if (panel && isVisible(panel)) panels.add(panel);
    });
    return [...panels];
  }

  function getFirstTurn(panel) {
    const scope = panel || document;
    const turns = [...scope.querySelectorAll("[data-turn-idx]")].filter(isVisible);
    return turns[0] || null;
  }

  function isInPanelHeader(btn, panel) {
    const scope = panel || document;
    const copyBtn = scope.querySelector('[data-test-id="copy-call-url-btn"]');
    if (copyBtn?.parentElement?.contains(btn)) return true;
    return Boolean(btn.closest('[data-test-id="conversation-review-header"]'));
  }

  function findNotesButton(panel) {
    const scope = panel || document;
    return (
      scope.querySelector('[data-test-id="conversation-note-btn"]') ||
      [...scope.querySelectorAll("button")].find((btn) => {
        const label = (btn.getAttribute("aria-label") || btn.title || "").toLowerCase();
        return label === "notes" || label.includes("add note");
      }) ||
      null
    );
  }

  function isTranscriptToolbarBar(bar, firstTurn) {
    if (!bar || !firstTurn) return false;

    const barRect = bar.getBoundingClientRect();
    const turnRect = firstTurn.getBoundingClientRect();
    if (barRect.width === 0 || barRect.height === 0) return false;

    const gap = turnRect.top - barRect.bottom;
    if (gap < -20 || gap > 200) return false;
    if (barRect.height > 120) return false;

    return true;
  }

  function isTranscriptActionButton(btn, panel) {
    if (isInPanelHeader(btn, panel)) return false;

    const label = (
      btn.getAttribute("aria-label") ||
      btn.title ||
      btn.textContent ||
      ""
    ).toLowerCase();
    if (
      label.includes("close") ||
      label.includes("dismiss") ||
      label.includes("external") ||
      label.includes("new tab") ||
      label.includes("share") ||
      label.includes("copy call") ||
      label.includes("call link") ||
      label.includes("pop out") ||
      label.includes("open in")
    ) {
      return false;
    }
    if (label.includes("diagnostic") || label.includes("diagnosis")) return false;
    if (
      label.includes("copy") ||
      label.includes("note") ||
      label.includes("setting") ||
      label.includes("edit") ||
      label.includes("download") ||
      label.includes("more")
    ) {
      return true;
    }
    return Boolean(btn.querySelector("svg") && !btn.textContent.trim());
  }

  function isAboveTranscript(btn, turnTop) {
    const rect = btn.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const gap = turnTop - rect.bottom;
    return gap >= -30 && gap < 500;
  }

  function findTranscriptActionBar(firstTurn, panel) {
    if (!firstTurn) return null;

    const turnTop = firstTurn.getBoundingClientRect().top;
    const scope = panel || getTranscriptPanel(firstTurn) || document;

    const notesBtn = findNotesButton(scope);
    if (notesBtn && isAboveTranscript(notesBtn, turnTop) && !isInPanelHeader(notesBtn, panel)) {
      const wrapper = notesBtn.parentElement;
      const bar = wrapper?.parentElement;
      if (bar && isTranscriptToolbarBar(bar, firstTurn)) {
        return { type: "bar", el: bar, insertBefore: wrapper || notesBtn };
      }
    }

    const candidates = [...scope.querySelectorAll("button, a")].filter((btn) => {
      if (btn.closest(".pt-translate-split")) return false;
      if (!isTranscriptActionButton(btn, panel)) return false;
      return isAboveTranscript(btn, turnTop);
    });

    if (candidates.length > 0) {
      const byParent = new Map();
      candidates.forEach((btn) => {
        const bar = btn.parentElement;
        if (!bar) return;
        if (!byParent.has(bar)) byParent.set(bar, []);
        byParent.get(bar).push(btn);
      });

      let bestBar = null;
      let bestButtons = [];
      for (const [bar, btns] of byParent) {
        if (btns.length > bestButtons.length) {
          bestBar = bar;
          bestButtons = btns;
        }
      }

      if (bestBar) {
        bestButtons.sort(
          (a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left
        );
        return { type: "bar", el: bestBar, insertBefore: bestButtons[0] };
      }
    }

    let node = firstTurn.parentElement;
    while (node && node !== scope && node !== document.body) {
      let prev = node.previousElementSibling;
      while (prev) {
        const gap = turnTop - prev.getBoundingClientRect().bottom;
        if (gap > 400) break;
        if (prev.querySelector("button") || getComputedStyle(prev).display.includes("flex")) {
          return { type: "bar", el: prev };
        }
        prev = prev.previousElementSibling;
      }
      node = node.parentElement;
    }

    const turnsContainer = firstTurn.parentElement;
    if (turnsContainer?.parentElement) {
      return {
        type: "before-turns",
        parent: turnsContainer.parentElement,
        before: turnsContainer,
      };
    }

    return null;
  }

  function isButtonWellPlaced(split, firstTurn, panel) {
    if (!split.isConnected || !isVisible(split)) return false;

    const root = panel || getTranscriptPanel(firstTurn);
    if (root && !root.contains(split)) return false;
    if (isInPanelHeader(split, root)) return false;

    const turnRect = firstTurn.getBoundingClientRect();
    const splitRect = split.getBoundingClientRect();
    const gap = turnRect.top - splitRect.bottom;
    if (gap < -30 || gap >= 500) return false;

    const rootRect = root?.getBoundingClientRect();
    if (rootRect && splitRect.right <= rootRect.left + rootRect.width * 0.45) {
      return false;
    }

    const notesBtn = findNotesButton(root);
    if (notesBtn) {
      const notesRect = notesBtn.getBoundingClientRect();
      const wrapper = notesBtn.parentElement;
      const toolbar = wrapper?.parentElement;
      if (!toolbar || !isTranscriptToolbarBar(toolbar, firstTurn)) return false;
      if (!toolbar.contains(split)) return false;
      if (split.nextElementSibling !== wrapper && split.parentElement !== toolbar) return false;
      if (splitRect.left >= notesRect.left - 4) return false;
      if (Math.abs(splitRect.bottom - notesRect.bottom) > 20) return false;
      return true;
    }

    const turnTop = turnRect.top;
    const scope = root || document;
    const siblingIcons = [...scope.querySelectorAll("button, a")].filter((b) => {
      if (b.closest(".pt-translate-split")) return false;
      return isTranscriptActionButton(b, panel) && isAboveTranscript(b, turnTop);
    });
    if (siblingIcons.length > 0) {
      siblingIcons.sort(
        (a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left
      );
      const leftmost = siblingIcons[0].getBoundingClientRect().left;
      if (splitRect.left >= leftmost - 4) return false;
    }

    return true;
  }

  function removeTranscriptTranslateButton() {
    document.querySelectorAll(".pt-transcript-toolbar").forEach((el) => el.remove());
    document.querySelectorAll(".pt-translate-split").forEach((el) => el.remove());
    document.querySelectorAll(".pt-translate-lang-dropdown").forEach((el) => el.remove());
  }

  let langDropdownAnchor = null;

  function positionLangDropdown(dropdown, langBtn) {
    const rect = langBtn.getBoundingClientRect();
    const dropdownRect = dropdown.getBoundingClientRect();
    const height = dropdownRect.height || 52;
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUp = spaceBelow < height + 12 && rect.top > height + 12;

    dropdown.style.position = "fixed";
    dropdown.style.left = "auto";
    dropdown.style.right = `${window.innerWidth - rect.right}px`;
    dropdown.style.zIndex = "2147483647";

    if (openUp) {
      dropdown.style.top = "auto";
      dropdown.style.bottom = `${window.innerHeight - rect.top + 6}px`;
      dropdown.classList.add("pt-translate-lang-dropdown-up");
    } else {
      dropdown.style.top = `${rect.bottom + 6}px`;
      dropdown.style.bottom = "auto";
      dropdown.classList.remove("pt-translate-lang-dropdown-up");
    }
  }

  function closeLangDropdown() {
    const dropdown = document.querySelector(".pt-translate-lang-dropdown");
    if (dropdown) dropdown.classList.remove("pt-translate-lang-dropdown-visible");
    langDropdownAnchor = null;
    document.querySelectorAll(".pt-translate-split").forEach((split) => {
      split.classList.remove("pt-lang-open");
    });
  }

  function buildTranslateSplit() {
    const split = document.createElement("div");
    split.className = "pt-translate-split";
    split.setAttribute("data-side-panel-ignore-outside-click", "true");

    const toggleBtn = document.createElement("button");
    toggleBtn.className = "pt-translate-toggle";
    toggleBtn.setAttribute("aria-label", "Translate transcript");
    toggleBtn.innerHTML = `<span class="pt-translate-toggle-icon">${TRANSLATE_ICON}</span>`;
    attachTranslateTooltip(toggleBtn);
    toggleBtn.addEventListener("click", toggleConversationTranslation);

    const langBtn = document.createElement("button");
    langBtn.className = "pt-translate-lang-btn";
    langBtn.setAttribute("aria-label", "Select languages");
    langBtn.innerHTML = `<span class="pt-translate-lang-label">${langPairLabel()}</span>`;

    const dropdown = document.createElement("div");
    dropdown.className = "pt-translate-lang-dropdown";
    dropdown.setAttribute("data-side-panel-ignore-outside-click", "true");

    function stopPanelClose(e) {
      e.stopPropagation();
    }

    const srcSelect = buildSelect(sourceLang);
    srcSelect.addEventListener("mousedown", stopPanelClose);
    srcSelect.addEventListener("click", stopPanelClose);
    srcSelect.addEventListener("change", async (e) => {
      sourceLang = e.target.value;
      saveSetting("pt_source", sourceLang);
      updateLangLabel();
      updateBadgeContent();
      if (conversationTranslateActive) {
        await retranslateConversation();
      }
    });

    const arrow = document.createElement("span");
    arrow.className = "pt-lang-arrow";
    arrow.textContent = "→";

    const tgtSelect = buildSelect(targetLang);
    tgtSelect.addEventListener("mousedown", stopPanelClose);
    tgtSelect.addEventListener("click", stopPanelClose);
    tgtSelect.addEventListener("change", async (e) => {
      targetLang = e.target.value;
      saveSetting("pt_target", targetLang);
      updateLangLabel();
      updateBadgeContent();
      if (conversationTranslateActive) {
        await retranslateConversation();
      }
    });

    dropdown.appendChild(srcSelect);
    dropdown.appendChild(arrow);
    dropdown.appendChild(tgtSelect);

    langBtn.addEventListener("mousedown", stopPanelClose);
    langBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const isOpen = dropdown.classList.contains("pt-translate-lang-dropdown-visible");
      if (isOpen) {
        closeLangDropdown();
        return;
      }
      if (!dropdown.isConnected || dropdown.parentElement !== document.body) {
        document.body.appendChild(dropdown);
      }
      split.classList.add("pt-lang-open");
      langDropdownAnchor = langBtn;
      positionLangDropdown(dropdown, langBtn);
      dropdown.classList.add("pt-translate-lang-dropdown-visible");
    });

    dropdown.addEventListener("mousedown", stopPanelClose);

    toggleBtn.addEventListener("mousedown", stopPanelClose);
    toggleBtn.addEventListener("click", (e) => e.stopPropagation());
    split.addEventListener("mousedown", stopPanelClose);

    split.appendChild(toggleBtn);
    split.appendChild(langBtn);

    split._ptDropdown = dropdown;
    return split;
  }

  function injectTranslateButton(panel, firstTurn) {
    const existing = panel.querySelector(".pt-translate-split");
    if (existing && isButtonWellPlaced(existing, firstTurn, panel)) return;
    if (existing) {
      existing.closest(".pt-transcript-toolbar")?.remove();
      if (existing.isConnected) existing.remove();
    }

    const anchor = findTranscriptActionBar(firstTurn, panel);
    if (!anchor) return;

    const split = buildTranslateSplit();

    if (anchor.type === "bar") {
      anchor.el.insertBefore(split, anchor.insertBefore || anchor.el.firstChild);
      return;
    }

    const toolbar = document.createElement("div");
    toolbar.className = "pt-transcript-toolbar";
    toolbar.appendChild(split);
    anchor.parent.insertBefore(toolbar, anchor.before);
  }

  function createTranscriptTranslateButton() {
    const panels = getTranscriptPanels();
    if (panels.length === 0) {
      removeTranscriptTranslateButton();
      return;
    }

    const activePanels = new Set(panels);
    document.querySelectorAll(".pt-translate-split").forEach((split) => {
      const panel =
        split.closest(
          "#conversation-review, [role='tabpanel'], main, aside, [data-side-panel], [role='dialog']"
        ) || getTranscriptPanel(split);
      if (!panel || !activePanels.has(panel)) {
        split.closest(".pt-transcript-toolbar")?.remove();
        if (split.isConnected) split.remove();
      }
    });

    panels.forEach((panel) => {
      const firstTurn = getFirstTurn(panel);
      if (firstTurn) injectTranslateButton(panel, firstTurn);
    });
  }

  function resetTranslateButton() {
    conversationTranslateActive = false;
    setTranslateToggleIdle();
  }

  let panelObserver = null;
  let liveTranslateDebounce = null;
  let lastConversationFingerprint = "";

  function getConversationFingerprint() {
    return getTranscriptPanels()
      .map((panel) => {
        const firstTurn = getFirstTurn(panel);
        if (!firstTurn) return "";
        const header = panel.querySelector("h1, h2, h3, [class*='title']");
        return (
          (firstTurn.getAttribute("data-turn-idx") || "") +
          (header?.textContent?.slice(0, 80) || "")
        );
      })
      .join("|");
  }

  function maybeResetOnConversationChange() {
    const fingerprint = getConversationFingerprint();
    if (!fingerprint) return;
    if (lastConversationFingerprint && fingerprint !== lastConversationFingerprint) {
      stopWatchingPanels();
      restoreConversationTurns();
      resetTranslateButton();
    }
    lastConversationFingerprint = fingerprint;
  }

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
          if (translated[i].trim().toLowerCase() === texts[i].trim().toLowerCase()) return;
          span.textContent = translated[i];
          span.classList.add("pt-translated");
        });
        setErrorState(false);
      } catch (err) {
        console.error("[PolyTranslate] Live translate failed:", err);
        setErrorState(true);
      }
    }, 300);
  }

  function watchPanels() {
    if (panelObserver) {
      panelObserver.disconnect();
      panelObserver = null;
    }

    const targets = [...getTranscriptPanels()];
    const chat = document.querySelector("#chat-panel");
    if (chat) targets.push(chat);

    if (targets.length === 0) return;

    panelObserver = new MutationObserver(() => {
      maybeResetOnConversationChange();
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

  async function retranslateConversation() {
    restoreConversationTurns();
    setTranslateToggleLoading();
    await translateConversationTurns();
    setTranslateToggleActive();
  }

  async function toggleConversationTranslation() {
    closeLangDropdown();

    conversationTranslateActive = !conversationTranslateActive;

    if (conversationTranslateActive) {
      setTranslateToggleLoading();
      await translateConversationTurns();
      setTranslateToggleActive();
      watchPanels();
    } else {
      stopWatchingPanels();
      restoreConversationTurns();
      setTranslateToggleIdle();
    }
  }

  function getConversationTurnSpans() {
    const spans = [];
    const seen = new Set();

    function addSpan(el) {
      if (!el || seen.has(el)) return;
      const text = el.textContent.trim();
      if (text.length === 0) return;
      if (/^[\w]+_function$/.test(text) || /^fx\s/.test(text)) return;
      seen.add(el);
      spans.push(el);
    }

    document.querySelectorAll("[data-turn-idx]").forEach((turn) => {
      const selectors = [
        "span.whitespace-pre-wrap",
        "[class*='MessageText']",
        "[class*='message-text']",
        "[class*='turn-text']",
        "p",
      ];
      for (const sel of selectors) {
        turn.querySelectorAll(sel).forEach(addSpan);
      }
    });

    if (spans.length === 0) {
      const roots = getTranscriptPanels();
      const scope = roots[0] || document;
      scope.querySelectorAll("[data-test-id='chat-message-text']").forEach((bubble) => {
        const textEl =
          bubble.querySelector("[class*='MessageText']") ||
          bubble.querySelector("div");
        addSpan(textEl);
      });
    }

    document.querySelectorAll('[data-test-id="chatMessages"] [data-test-id="chat-message-text"]').forEach((bubble) => {
      const textEl =
        bubble.querySelector("[class*='MessageText']") ||
        bubble.querySelector("div.gzGCB") ||
        bubble.querySelector(".sc-erUUZj") ||
        bubble.querySelector("div");
      addSpan(textEl);
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
        if (translated[i].trim().toLowerCase() === texts[i].trim().toLowerCase()) return;
        span.textContent = translated[i];
        span.classList.add("pt-translated");
      });
      setErrorState(false);
    } catch (err) {
      console.error("[PolyTranslate] Conversation translation failed:", err);
      setErrorState(true);
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

  function handleTranslateShortcut(e) {
    if (!((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "y" || e.key === "Y"))) {
      return;
    }

    const chatTextarea = document.querySelector("#chat-panel textarea");
    if (
      chatTextarea &&
      document.activeElement === chatTextarea &&
      chatTextarea.value.trim()
    ) {
      e.preventDefault();
      e.stopPropagation();
      translateInput(chatTextarea);
      return;
    }

    const transcriptBtn = document.querySelector(".pt-translate-toggle");
    const hasTranscript = document.querySelector("[data-turn-idx]");
    if (transcriptBtn && hasTranscript) {
      e.preventDefault();
      e.stopPropagation();
      toggleConversationTranslation();
    }
  }

  // ── Feature 2: Input auto-translator ──

  function createInputTranslateButton() {
    const textarea = document.querySelector("#chat-panel textarea");
    if (!textarea || textarea.dataset.ptBound) return;

    document.querySelectorAll(".pt-input-anchor").forEach((el) => el.remove());

    textarea.dataset.ptBound = "true";

    const wrapper = textarea.closest(".dAvboU") || textarea.closest("div");
    if (!wrapper) return;

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
      setErrorState(false);
    } catch (err) {
      console.error("[PolyTranslate] Input translation failed:", err);
      setErrorState(true);
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
    createTranscriptTranslateButton();
    createInputTranslateButton();
  }

  function isIgnorableDomMutation(mutations) {
    const changed = [];
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === 1) changed.push(node);
      });
      mutation.removedNodes.forEach((node) => {
        if (node.nodeType === 1) changed.push(node);
      });
    }
    if (changed.length === 0) return true;

    return changed.every((node) => {
      if (
        node.matches?.(
          ".pt-translate-split, .pt-translate-lang-dropdown, .pt-transcript-toolbar, [data-floating-ui-portal], [role='tooltip']"
        )
      ) {
        return true;
      }
      return Boolean(
        node.closest?.(
          ".pt-translate-split, .pt-translate-lang-dropdown, .pt-transcript-toolbar, [data-floating-ui-portal], [role='tooltip']"
        )
      );
    });
  }

  let pageObserverDebounce = null;
  const pageObserver = new MutationObserver((mutations) => {
    if (!chrome.runtime?.id) {
      pageObserver.disconnect();
      return;
    }
    if (isIgnorableDomMutation(mutations)) return;
    if (pageObserverDebounce) return;
    pageObserverDebounce = setTimeout(() => {
      pageObserverDebounce = null;
      createTranscriptTranslateButton();
      createInputTranslateButton();

      if (conversationTranslateActive) {
        watchPanels();
      }
    }, 200);
  });

  document.addEventListener("keydown", handleTranslateShortcut, true);

  document.addEventListener("click", (e) => {
    const dropdown = document.querySelector(".pt-translate-lang-dropdown");
    const clickedInsideSplit = [...document.querySelectorAll(".pt-translate-split")].some(
      (split) => split.contains(e.target)
    );
    if (
      dropdown?.classList.contains("pt-translate-lang-dropdown-visible") &&
      !dropdown.contains(e.target) &&
      !clickedInsideSplit
    ) {
      closeLangDropdown();
    }
  });

  window.addEventListener(
    "scroll",
    () => {
      const dropdown = document.querySelector(".pt-translate-lang-dropdown");
      if (
        dropdown?.classList.contains("pt-translate-lang-dropdown-visible") &&
        langDropdownAnchor
      ) {
        positionLangDropdown(dropdown, langDropdownAnchor);
      }
    },
    true
  );

  window.addEventListener("resize", () => {
    const dropdown = document.querySelector(".pt-translate-lang-dropdown");
    if (
      dropdown?.classList.contains("pt-translate-lang-dropdown-visible") &&
      langDropdownAnchor
    ) {
      positionLangDropdown(dropdown, langDropdownAnchor);
    }
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
