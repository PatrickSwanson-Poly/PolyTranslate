async function translateText(text, sourceLang, targetLang) {
  const params = new URLSearchParams({
    client: "gtx",
    sl: sourceLang,
    tl: targetLang,
    dt: "t",
    q: text,
  });

  const response = await fetch(
    `https://translate.googleapis.com/translate_a/single?${params}`
  );

  if (!response.ok) {
    throw new Error(`Translation error: ${response.status}`);
  }

  const data = await response.json();
  return data[0].map((seg) => seg[0]).join("");
}

async function translateBatch(texts, sourceLang, targetLang) {
  // The free endpoint doesn't support batch, so translate in parallel
  const results = await Promise.all(
    texts.map((text) => translateText(text, sourceLang, targetLang))
  );
  return results;
}
