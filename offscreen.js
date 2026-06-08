var Module = {};

const GEMM_TO_FALLBACK = {
  int8_prepare_a: "int8PrepareAFallback",
  int8_prepare_b: "int8PrepareBFallback",
  int8_prepare_b_from_transposed: "int8PrepareBFromTransposedFallback",
  int8_prepare_b_from_quantized_transposed:
    "int8PrepareBFromQuantizedTransposedFallback",
  int8_prepare_bias: "int8PrepareBiasFallback",
  int8_multiply_and_add_bias: "int8MultiplyAndAddBiasFallback",
  int8_select_columns_of_b: "int8SelectColumnsOfBFallback",
};

let bergamotModule = null;
let translationService = null;
let initPromise = null;
const loadedModels = new Map();
const pendingModels = new Map();

function linkFallbackIntGemm(info) {
  return Object.fromEntries(
    Object.entries(GEMM_TO_FALLBACK).map(([key, name]) => [
      key,
      (...args) => Module.asm[name](...args),
    ])
  );
}

function initBergamot() {
  if (bergamotModule) return Promise.resolve(bergamotModule);
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const wasmResponse = await fetch("bergamot-translator-worker.wasm");

    return new Promise((resolve, reject) => {
      Module.instantiateWasm = (info, accept) => {
        WebAssembly.instantiateStreaming(wasmResponse, {
          ...info,
          wasm_gemm: linkFallbackIntGemm(info),
        })
          .then(({ instance }) => accept(instance))
          .catch(reject);
        return {};
      };
      Module.onRuntimeInitialized = () => {
        bergamotModule = Module;
        translationService = new Module.BlockingService({ cacheSize: 0 });
        resolve(Module);
      };

      const script = document.createElement("script");
      script.src = "bergamot-translator-worker.js";
      script.onerror = () =>
        reject(new Error("Failed to load WASM glue code"));
      document.head.appendChild(script);
    });
  })();

  return initPromise;
}

// ── Local model file loading ──

async function loadLocalFile(pairKey, fileName) {
  const url = `models/${pairKey}/${fileName}`;
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(
      `Model file not found: ${url} — run "polyt add" to download models`
    );
  return response.arrayBuffer();
}

async function loadManifest(pairKey) {
  const url = `models/${pairKey}/manifest.json`;
  const response = await fetch(url);
  if (!response.ok) return null;
  return response.json();
}

// ── Model loading ──

function prepareAlignedMemory(buffer, alignmentSize) {
  const bytes = new Int8Array(buffer);
  const memory = new bergamotModule.AlignedMemory(
    bytes.byteLength,
    alignmentSize
  );
  memory.getByteArrayView().set(bytes);
  return memory;
}

function yamlConfig(overrides) {
  const defaults = {
    "beam-size": "1",
    normalize: "1.0",
    "word-penalty": "0",
    "cpu-threads": "0",
    "gemm-precision": "int8shiftAlphaAll",
    "skip-cost": "true",
    alignment: "soft",
    quiet: "true",
    "quiet-translation": "true",
    "max-length-break": "128",
    "mini-batch-words": "1024",
    workspace: "128",
    "max-length-factor": "2.0",
    ...overrides,
  };
  return Object.entries(defaults)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

async function ensureModel(from, to) {
  const key = `${from}_${to}`;
  if (loadedModels.has(key)) return;
  if (pendingModels.has(key)) return pendingModels.get(key);

  const promise = loadModel(from, to, key);
  pendingModels.set(key, promise);
  await promise;
  pendingModels.delete(key);
}

async function loadModel(from, to, key) {
  const manifest = await loadManifest(key);
  if (!manifest)
    throw new Error(
      `No model installed for ${from} → ${to} — run "polyt add" to download it`
    );

  const buffers = {};
  await Promise.all(
    Object.entries(manifest).map(async ([type, fileName]) => {
      buffers[type] = await loadLocalFile(key, fileName);
    })
  );

  const modelMemory = prepareAlignedMemory(buffers.model, 256);
  const shortlistMemory = prepareAlignedMemory(buffers.lex, 64);

  const vocabBuffers = buffers.vocab
    ? [buffers.vocab]
    : [buffers.srcvocab, buffers.trgvocab];

  const uniqueVocabs = vocabBuffers.filter(
    (buf, i, arr) => arr.indexOf(buf) === i
  );

  const vocabs = new bergamotModule.AlignedMemoryList();
  uniqueVocabs.forEach((buf) =>
    vocabs.push_back(prepareAlignedMemory(buf, 64))
  );

  const model = new bergamotModule.TranslationModel(
    yamlConfig({}),
    modelMemory,
    shortlistMemory,
    vocabs,
    null
  );
  loadedModels.set(key, model);
}

// ── Translation ──

function bergamotLangCode(ourCode) {
  return BERGAMOT_LANG_MAP[ourCode] || ourCode;
}

function directModelExists(from, to) {
  const key = `${bergamotLangCode(from)}_${bergamotLangCode(to)}`;
  return key in MODEL_REGISTRY;
}

async function translateTexts(texts, sourceLang, targetLang) {
  await initBergamot();

  const from = bergamotLangCode(sourceLang);
  const to = bergamotLangCode(targetLang);

  if (from === to) return texts;

  const needsPivot = !directModelExists(sourceLang, targetLang);
  const models = [];

  if (needsPivot) {
    await ensureModel(from, "en");
    await ensureModel("en", to);
    models.push(loadedModels.get(`${from}_en`), loadedModels.get(`en_${to}`));
  } else {
    await ensureModel(from, to);
    models.push(loadedModels.get(`${from}_${to}`));
  }

  const input = new bergamotModule.VectorString();
  texts.forEach((t) => input.push_back(t));

  const options = new bergamotModule.VectorResponseOptions();
  texts.forEach(() =>
    options.push_back({ alignment: false, html: false, qualityScores: false })
  );

  const responses =
    models.length > 1
      ? translationService.translateViaPivoting(
          models[0],
          models[1],
          input,
          options
        )
      : translationService.translate(models[0], input, options);

  const results = [];
  for (let i = 0; i < texts.length; i++) {
    results.push(responses.get(i).getTranslatedText());
  }

  input.delete();
  options.delete();
  responses.delete();

  return results;
}

// ── Message handler ──

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "bergamot-translate") return;

  translateTexts(message.texts, message.sourceLang, message.targetLang)
    .then((results) => sendResponse({ results }))
    .catch((err) => sendResponse({ error: err.message }));

  return true;
});
