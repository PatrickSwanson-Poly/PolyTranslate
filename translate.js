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
        "PolyTranslate was reloaded — refresh this page to continue"
      );
    }
    if (msg.includes("Receiving end does not exist")) {
      throw new Error(
        "PolyTranslate is unavailable — refresh this page and try again"
      );
    }
    throw new Error(`Could not reach PolyTranslate: ${msg}`);
  }

  if (!response) {
    throw new Error(
      "PolyTranslate did not respond — refresh this page and try again"
    );
  }
  if (response.error) throw new Error(response.error);
  if (!response.results) {
    throw new Error("PolyTranslate returned an empty translation response");
  }
  return response.results;
}
