async function translateText(text, sourceLang, targetLang) {
  const results = await translateBatch([text], sourceLang, targetLang);
  return results[0];
}

async function translateBatch(texts, sourceLang, targetLang) {
  const response = await chrome.runtime.sendMessage({
    type: "translate",
    texts,
    sourceLang,
    targetLang,
  });

  if (response.error) throw new Error(response.error);
  return response.results;
}
