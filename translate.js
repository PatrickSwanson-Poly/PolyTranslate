async function translateText(text, sourceLang, targetLang) {
  const results = await translateBatch([text], sourceLang, targetLang);
  return results[0];
}

async function translateBatch(texts, sourceLang, targetLang) {
  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: "translate",
      texts,
      sourceLang,
      targetLang,
    });
  } catch (err) {
    const msg = err?.message || String(err);
    if (msg.includes("Extension context invalidated")) {
      throw new Error(
        `PolyTranslate was updated: ${err.message}. Refresh this page.`
      );
    }
    throw new Error(
      `Could not reach PolyTranslate: ${err.message}. Refresh this page.`
    );
  }

  if (!response) {
    throw new Error("Could not reach PolyTranslate. Refresh this page.");
  }
  if (response.error) throw new Error(response.error);
  if (!response.results) {
    throw new Error("Translation engine returned no response. Refresh this page.");
  }
  return response.results;
}
