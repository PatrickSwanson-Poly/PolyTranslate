(function () {
  "use strict";

  console.log("[PolyTranslate] Content script loaded on", window.location.href);

  const LANG_ABBR = {
    es: "ES", en: "EN", zh: "ZH", ja: "JA", ko: "KO", pt: "PT",
    ar: "AR", fr: "FR", de: "DE", it: "IT", nl: "NL", ru: "RU",
    pl: "PL", sv: "SV", da: "DA", no: "NO", fi: "FI", he: "HE",
    hi: "HI", th: "TH", vi: "VI", uk: "UK", ro: "RO", el: "EL",
    sr: "SR",
  };

  let conversationTranslateActive = false;
  const originalTexts = new WeakMap();
  const TRANSCRIPT_ICON_OK = chrome.runtime.getURL("icons/icon48_no_background.png");
  const LOGO_OK = chrome.runtime.getURL("icons/icon48_send.png");
  const LOGO_ERR = chrome.runtime.getURL("icons/icon48_err.png");

  function transcriptIconHtml(size = 16) {
    return `<img src="${TRANSCRIPT_ICON_OK}" width="${size}" height="${size}" alt="">`;
  }

  function setErrorState(on) {
    document.querySelectorAll(".pt-translate-toggle img").forEach((img) => {
      img.src = on ? LOGO_ERR : TRANSCRIPT_ICON_OK;
    });
    document.querySelectorAll(".pt-input-circle-btn img").forEach((img) => {
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

  function translateTooltipLabel() {
    return navigator.platform.includes("Mac")
      ? "Translate ⌘⇧U"
      : "Translate Ctrl+Shift+U";
  }

  function setToggleIcon(btn, html) {
    const icon = btn.querySelector(".pt-translate-toggle-icon");
    if (icon) icon.innerHTML = html;
  }

  function attachTranslateTooltip(btn) {
    let tooltip = btn.querySelector(".pt-translate-tooltip");
    if (!tooltip) {
      tooltip = document.createElement("span");
      tooltip.className = "pt-translate-tooltip";
      tooltip.setAttribute("aria-hidden", "true");
      tooltip.innerHTML =
        '<span class="pt-translate-tooltip-label"></span>' +
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
    const label = tooltip.querySelector(".pt-translate-tooltip-label");
    if (label) label.textContent = translateTooltipLabel();
  }

  function setTranslateToggleIdle() {
    setTranslateSplitActive(false);
    document.querySelectorAll(".pt-translate-toggle").forEach((btn) => {
      btn.classList.remove("pt-active");
      setToggleIcon(btn, transcriptIconHtml());
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
      setToggleIcon(btn, transcriptIconHtml());
      attachTranslateTooltip(btn);
      btn.setAttribute("aria-label", "Translation active");
    });
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

  function getNotesToolbarAnchor(scope, panel) {
    const notesBtn = findNotesButton(scope);
    if (!notesBtn || isInPanelHeader(notesBtn, panel)) return null;

    const wrapper = notesBtn.parentElement;
    const bar = wrapper?.parentElement;
    if (!bar) return null;

    return { type: "bar", el: bar, insertBefore: wrapper || notesBtn };
  }

  function isTranslateNotesToolbar(split, panel) {
    const root = panel || getTranscriptPanel(split) || document;
    const notesBtn = findNotesButton(root);
    if (!notesBtn) return false;

    const wrapper = notesBtn.parentElement;
    const toolbar = wrapper?.parentElement;
    if (!toolbar || !toolbar.contains(split) || !toolbar.contains(notesBtn)) return false;
    if (isInPanelHeader(split, root)) return false;

    const children = [...toolbar.children];
    const splitIdx = children.indexOf(split);
    const notesIdx = wrapper ? children.indexOf(wrapper) : children.indexOf(notesBtn);
    return splitIdx >= 0 && notesIdx >= 0 && splitIdx < notesIdx;
  }

  function findTranscriptActionBar(firstTurn, panel) {
    if (!firstTurn) return null;

    const turnTop = firstTurn.getBoundingClientRect().top;
    const scope = panel || getTranscriptPanel(firstTurn) || document;

    const notesAnchor = getNotesToolbarAnchor(scope, panel);
    if (notesAnchor) return notesAnchor;

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

    if (isTranslateNotesToolbar(split, panel || root)) return true;

    const fallbackToolbar = split.closest(".pt-transcript-toolbar");
    if (fallbackToolbar && firstTurn && root?.contains(fallbackToolbar)) {
      return true;
    }

    return false;
  }

  function removeTranscriptTranslateButton() {
    document.querySelectorAll(".pt-transcript-toolbar").forEach((el) => el.remove());
    document.querySelectorAll(".pt-translate-split:not(.pt-chat-translate-split)").forEach((el) => el.remove());
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
    toggleBtn.innerHTML = `<span class="pt-translate-toggle-icon">${transcriptIconHtml()}</span>`;
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
    document.querySelectorAll(".pt-translate-split:not(.pt-chat-translate-split)").forEach((split) => {
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
        (s) => !s.classList.contains("pt-translated")
      );
      if (spans.length === 0) return;

      const texts = spans.map((s) => getSpanPlainText(s).trim());
      spans.forEach((s, i) => originalTexts.set(s, texts[i]));

      try {
        const translated = await translateBatch(texts, sourceLang, targetLang);
        applyTurnTranslations(spans, texts, translated);
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

  function isPtTranslationPart(el) {
    return Boolean(
      el.classList.contains("pt-turn-translation") ||
      el.classList.contains("pt-turn-original") ||
      el.classList.contains("pt-turn-translated") ||
      el.classList.contains("pt-turn-primary") ||
      el.classList.contains("pt-turn-note")
    );
  }

  function isSpeakerLabelText(text) {
    return /^(agent|caller|user|assistant)$/i.test(text.trim());
  }

  function isNonMessageText(text) {
    const trimmed = text.trim();
    if (!trimmed) return true;
    if (isSpeakerLabelText(trimmed)) return true;
    if (/^[\w]+_function$/.test(trimmed) || /^fx\s/.test(trimmed)) return true;
    if (/^Caller ID:/i.test(trimmed)) return true;
    if (/^Set skill /i.test(trimmed)) return true;
    if (/^Request \d+$/i.test(trimmed)) return true;
    if (/^Matched topic/i.test(trimmed)) return true;
    return false;
  }

  function isAgentCallerUtteranceButton(btn) {
    if (!btn) return false;
    const testId = btn.getAttribute("data-test-id") || "";
    if (testId.startsWith("function-call-")) return false;
    return [...btn.querySelectorAll("p")].some((p) =>
      /^(agent|caller)$/i.test(p.textContent.trim())
    );
  }

  function isAgentCallerUtteranceElement(el) {
    const btn = el.closest("button.select-text, button[data-dd-privacy='mask']");
    if (!btn) return false;
    if (el.closest('[data-test-id^="function-call-"]')) return false;
    return isAgentCallerUtteranceButton(btn);
  }

  function findTurnMessageEls(turn) {
    const selectors = [
      "[data-test-id='chat-message-text']",
      "[class*='MessageText']",
      "[class*='message-text']",
      "[class*='turn-text']",
      "span.whitespace-pre-wrap",
      "span[class*='text-body-regular']",
    ];
    const candidates = [];
    const seen = new Set();

    for (const sel of selectors) {
      for (const el of turn.querySelectorAll(sel)) {
        if (isPtTranslationPart(el) || seen.has(el)) continue;
        seen.add(el);
        candidates.push(el);
      }
    }

    const valid = candidates.filter((el) => !isNonMessageText(getSpanPlainText(el)));
    return valid.filter(
      (el) => !valid.some((other) => other !== el && el.contains(other))
    );
  }

  function getConversationTurnSpans() {
    const spans = [];
    const seen = new Set();

    function addSpan(el) {
      if (!el || seen.has(el)) return;
      if (!isAgentCallerUtteranceElement(el)) return;
      const text = getSpanPlainText(el).trim();
      if (isNonMessageText(text)) return;
      seen.add(el);
      spans.push(el);
    }

    document
      .querySelectorAll("button.select-text, button[data-dd-privacy='mask']")
      .forEach((btn) => {
        if (!isAgentCallerUtteranceButton(btn)) return;
        for (const el of findTurnMessageEls(btn)) {
          addSpan(el);
        }
      });

    document
      .querySelectorAll('[data-test-id="chatMessages"] [data-test-id="chat-message-text"]')
      .forEach((bubble) => {
        const textEl =
          bubble.querySelector("[class*='MessageText']") ||
          bubble.querySelector("div");
        if (textEl && !seen.has(textEl)) {
          const text = getSpanPlainText(textEl).trim();
          if (!isNonMessageText(text)) {
            seen.add(textEl);
            spans.push(textEl);
          }
        }
      });

    return spans;
  }

  function getSpanPlainText(span) {
    if (originalTexts.has(span)) return originalTexts.get(span);
    const primary =
      span.querySelector(".pt-turn-original") ||
      span.querySelector(".pt-turn-primary");
    if (primary) return primary.textContent;
    return span.textContent;
  }

  function translationNotNeeded(original, translated) {
    if (sourceLang === targetLang) return true;
    return translated.trim().toLowerCase() === original.trim().toLowerCase();
  }

  function renderTurnTranslation(span, original, translated) {
    span.textContent = "";
    span.classList.remove("pt-no-translation");
    span.classList.add("pt-translated");

    const wrap = document.createElement("span");
    wrap.className = "pt-turn-translation";

    if (translationNotNeeded(original, translated)) {
      wrap.classList.add("pt-turn-unchanged");
      const primary = document.createElement("span");
      primary.className = "pt-turn-primary";
      primary.textContent = original;
      const note = document.createElement("span");
      note.className = "pt-turn-note";
      note.textContent = "No translation needed";
      wrap.appendChild(primary);
      wrap.appendChild(note);
      span.classList.add("pt-no-translation");
    } else {
      const orig = document.createElement("span");
      orig.className = "pt-turn-original";
      orig.textContent = original;
      const trans = document.createElement("span");
      trans.className = "pt-turn-translated";
      trans.textContent = translated;
      wrap.appendChild(orig);
      wrap.appendChild(trans);
    }

    span.appendChild(wrap);
  }

  function isChatMessageSpan(span) {
    return Boolean(span.closest('[data-test-id="chatMessages"]'));
  }

  function renderChatInlineTranslation(span, original, translated) {
    if (translationNotNeeded(original, translated)) return;
    originalTexts.set(span, original);
    span.textContent = translated;
    span.classList.add("pt-translated", "pt-chat-inline");
    span.setAttribute("data-pt-lang", langAbbr(targetLang));
  }

  function applyTurnTranslations(spans, texts, translated) {
    spans.forEach((span, i) => {
      const original = texts[i];
      originalTexts.set(span, original);
      if (isChatMessageSpan(span)) {
        renderChatInlineTranslation(span, original, translated[i]);
      } else {
        renderTurnTranslation(span, original, translated[i]);
      }
    });
  }

  async function translateConversationTurns() {
    const spans = getConversationTurnSpans();
    if (spans.length === 0) return;

    const texts = spans.map((s) => getSpanPlainText(s).trim());
    spans.forEach((s, i) => originalTexts.set(s, texts[i]));

    try {
      const translated = await translateBatch(texts, sourceLang, targetLang);
      applyTurnTranslations(spans, texts, translated);
      setErrorState(false);
    } catch (err) {
      console.error("[PolyTranslate] Conversation translation failed:", err);
      setErrorState(true);
    }
  }

  function restoreConversationTurns() {
    const spans = new Set(getConversationTurnSpans());
    document.querySelectorAll(".pt-translated").forEach((span) => spans.add(span));

    spans.forEach((span) => {
      const original = originalTexts.get(span);
      if (original !== undefined) {
        span.textContent = original;
        span.classList.remove("pt-translated", "pt-no-translation", "pt-has-original", "pt-chat-inline");
        span.removeAttribute("data-pt-lang");
      }
    });
  }

  function handleTranslateShortcut(e) {
    if (!((e.metaKey || e.ctrlKey) && e.shiftKey)) return;

    if (e.key === "y" || e.key === "Y") {
      const chatTextarea = document.querySelector("#chat-panel textarea");
      if (
        chatTextarea &&
        document.activeElement === chatTextarea &&
        chatTextarea.value.trim()
      ) {
        e.preventDefault();
        e.stopPropagation();
        translateInput(chatTextarea);
      }
      return;
    }

    if (e.key === "u" || e.key === "U") {
      const transcriptBtn = document.querySelector(".pt-translate-toggle");
      const hasContent = document.querySelector("[data-turn-idx]") ||
        document.querySelector('[data-test-id="chatMessages"]');
      if (transcriptBtn && hasContent) {
        e.preventDefault();
        e.stopPropagation();
        toggleConversationTranslation();
      }
    }
  }

  // ── Feature 1b: Live chat translate button ──

  function createChatTranslateButton() {
    const chatPanel = document.querySelector("#chat-panel");
    if (!chatPanel) {
      document.querySelectorAll(".pt-chat-translate-split").forEach((el) => el.remove());
      return;
    }

    if (chatPanel.querySelector(".pt-chat-translate-split")) return;

    const reviewBtn = chatPanel.querySelector("[aria-label='Review Conversation']");
    const rightGroup = reviewBtn?.closest("[style*='gap']");
    if (!rightGroup) return;

    const split = buildTranslateSplit();
    split.classList.add("pt-chat-translate-split");
    rightGroup.prepend(split);
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

    const logoUrl = chrome.runtime.getURL("icons/icon48_send.png");
    const circleBtn = document.createElement("button");
    circleBtn.className = "pt-input-circle-btn";
    const inputShortcut = navigator.platform.includes("Mac") ? "Translate ⌘⇧Y" : "Translate Ctrl+Shift+Y";
    circleBtn.setAttribute("data-pt-tooltip", inputShortcut);
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
      const logoUrl = chrome.runtime.getURL("icons/icon48_send.png");
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

    createTranscriptTranslateButton();
    createChatTranslateButton();
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
          ".pt-translate-split, .pt-translate-lang-dropdown, .pt-transcript-toolbar, .pt-chat-translate-split, [data-floating-ui-portal], [role='tooltip']"
        )
      ) {
        return true;
      }
      return Boolean(
        node.closest?.(
          ".pt-translate-split, .pt-translate-lang-dropdown, .pt-transcript-toolbar, .pt-chat-translate-split, [data-floating-ui-portal], [role='tooltip']"
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
      createChatTranslateButton();
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
