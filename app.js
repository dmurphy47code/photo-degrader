"use strict";

const elements = {
  fileInput: document.querySelector("#file-input"),
  dropZone: document.querySelector("#drop-zone"),
  compareArea: document.querySelector("#compare-area"),
  originalCanvas: document.querySelector("#original-canvas"),
  resultCanvas: document.querySelector("#result-canvas"),
  selectedName: document.querySelector("#selected-name"),
  imageMeta: document.querySelector("#image-meta"),
  originalMeta: document.querySelector("#original-meta"),
  resultMeta: document.querySelector("#result-meta"),
  quality: document.querySelector("#quality"),
  scale: document.querySelector("#scale"),
  blur: document.querySelector("#blur"),
  qualityOutput: document.querySelector("#quality-output"),
  scaleOutput: document.querySelector("#scale-output"),
  blurOutput: document.querySelector("#blur-output"),
  presets: [...document.querySelectorAll(".preset")],
  resetSettings: document.querySelector("#reset-settings"),
  removeCurrent: document.querySelector("#remove-current"),
  downloadCurrent: document.querySelector("#download-current"),
  downloadAll: document.querySelector("#download-all"),
  downloadCount: document.querySelector("#download-count"),
  queueSection: document.querySelector("#queue-section"),
  queueCount: document.querySelector("#queue-count"),
  fileList: document.querySelector("#file-list"),
  clearAll: document.querySelector("#clear-all"),
  toast: document.querySelector("#toast"),
};

const state = {
  items: [],
  currentId: null,
  previewTimer: null,
  previewToken: 0,
  currentPreviewBlob: null,
  toastTimer: null,
};

const DEFAULTS = { quality: 35, scale: 70, blur: 0.6 };
const SUPPORTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function getSettings() {
  return {
    quality: Number(elements.quality.value),
    scale: Number(elements.scale.value),
    blur: Number(elements.blur.value),
  };
}

function currentItem() {
  return state.items.find((item) => item.id === state.currentId) ?? null;
}

function formatBytes(bytes) {
  const units = ["Б", "КБ", "МБ", "ГБ"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function safeName(name) {
  const stem = name.replace(/\.[^.]+$/, "") || "photo";
  return `${stem}_degraded.jpg`;
}

function uniqueNames(items) {
  const used = new Set();
  return items.map(({ item, blob }) => {
    const original = safeName(item.file.name);
    const dot = original.lastIndexOf(".");
    const stem = original.slice(0, dot);
    const extension = original.slice(dot);
    let name = original;
    let counter = 2;
    while (used.has(name.toLocaleLowerCase())) {
      name = `${stem}_${counter}${extension}`;
      counter += 1;
    }
    used.add(name.toLocaleLowerCase());
    return { name, blob };
  });
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  state.toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 2600);
}

function updateRange(range) {
  const min = Number(range.min);
  const max = Number(range.max);
  const progress = ((Number(range.value) - min) / (max - min)) * 100;
  range.style.setProperty("--range-progress", `${progress}%`);
}

function syncControls() {
  elements.qualityOutput.value = `${elements.quality.value}%`;
  elements.scaleOutput.value = `${elements.scale.value}%`;
  elements.blurOutput.value = Number(elements.blur.value).toFixed(1);
  [elements.quality, elements.scale, elements.blur].forEach(updateRange);

  const settings = getSettings();
  elements.presets.forEach((button) => {
    const matches =
      Number(button.dataset.quality) === settings.quality &&
      Number(button.dataset.scale) === settings.scale &&
      Number(button.dataset.blur) === settings.blur;
    button.classList.toggle("active", matches);
  });
}

async function loadBitmap(item) {
  if (item.bitmap) return item.bitmap;
  try {
    item.bitmap = await createImageBitmap(item.file, { imageOrientation: "from-image" });
  } catch {
    item.bitmap = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Не удалось открыть изображение"));
      image.src = item.url;
    });
  }
  return item.bitmap;
}

function safeDimensions(width, height, scalePercent, maxDimension = 16384, maxPixels = 64_000_000) {
  let targetWidth = Math.max(1, Math.round(width * scalePercent / 100));
  let targetHeight = Math.max(1, Math.round(height * scalePercent / 100));
  const dimensionRatio = Math.min(1, maxDimension / Math.max(targetWidth, targetHeight));
  const pixelRatio = Math.min(1, Math.sqrt(maxPixels / (targetWidth * targetHeight)));
  const ratio = Math.min(dimensionRatio, pixelRatio);
  targetWidth = Math.max(1, Math.floor(targetWidth * ratio));
  targetHeight = Math.max(1, Math.floor(targetHeight * ratio));
  return { width: targetWidth, height: targetHeight, limited: ratio < 1 };
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("Браузер не смог создать JPEG")),
      "image/jpeg",
      quality / 100,
    );
  });
}

async function processItem(item, { preview = false } = {}) {
  const bitmap = await loadBitmap(item);
  const settings = getSettings();
  const dimensions = safeDimensions(bitmap.width, bitmap.height, settings.scale);
  let width = dimensions.width;
  let height = dimensions.height;

  if (preview) {
    const previewRatio = Math.min(1, 1800 / Math.max(width, height));
    width = Math.max(1, Math.round(width * previewRatio));
    height = Math.max(1, Math.round(height * previewRatio));
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.filter = settings.blur > 0 ? `blur(${settings.blur}px)` : "none";
  context.drawImage(bitmap, 0, 0, width, height);
  context.filter = "none";

  const blob = await canvasToBlob(canvas, settings.quality);
  return { blob, dimensions, previewDimensions: { width, height } };
}

function drawToPreview(canvas, image) {
  const parent = canvas.parentElement;
  const bounds = parent.getBoundingClientRect();
  const width = Math.max(1, Math.floor(bounds.width));
  const height = Math.max(1, Math.floor(bounds.height));
  const ratio = Math.min(width / image.width, height / image.height);
  const drawWidth = Math.max(1, Math.round(image.width * ratio));
  const drawHeight = Math.max(1, Math.round(image.height * ratio));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const context = canvas.getContext("2d", { alpha: true });
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}

async function refreshPreview() {
  const item = currentItem();
  if (!item) return;
  const token = ++state.previewToken;

  try {
    const bitmap = await loadBitmap(item);
    if (token !== state.previewToken) return;
    drawToPreview(elements.originalCanvas, bitmap);

    const result = await processItem(item, { preview: true });
    if (token !== state.previewToken) return;
    const resultBitmap = await createImageBitmap(result.blob);
    if (token !== state.previewToken) {
      resultBitmap.close();
      return;
    }
    drawToPreview(elements.resultCanvas, resultBitmap);
    resultBitmap.close();
    state.currentPreviewBlob = result.blob;

    const estimatedSize = Math.max(
      result.blob.size,
      Math.round(
        result.blob.size *
        (result.dimensions.width * result.dimensions.height) /
        (result.previewDimensions.width * result.previewDimensions.height),
      ),
    );
    elements.originalMeta.textContent = `${bitmap.width}×${bitmap.height} · ${formatBytes(item.file.size)}`;
    elements.resultMeta.textContent =
      `${result.dimensions.width}×${result.dimensions.height} · ≈ ${formatBytes(estimatedSize)}`;
  } catch (error) {
    if (token === state.previewToken) showToast(error.message || "Не удалось обработать фото");
  }
}

function schedulePreview() {
  syncControls();
  clearTimeout(state.previewTimer);
  state.previewTimer = setTimeout(refreshPreview, 90);
}

function renderFileList() {
  elements.fileList.replaceChildren();
  state.items.forEach((item) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `file-card${item.id === state.currentId ? " active" : ""}`;
    card.dataset.id = item.id;

    const image = document.createElement("img");
    image.className = "file-thumb";
    image.src = item.url;
    image.alt = "";

    const copy = document.createElement("span");
    copy.className = "file-copy";
    const name = document.createElement("strong");
    name.textContent = item.file.name;
    const meta = document.createElement("small");
    meta.textContent = formatBytes(item.file.size);
    copy.append(name, meta);
    card.append(image, copy);
    card.addEventListener("click", () => selectItem(item.id));
    elements.fileList.append(card);
  });
}

function updateInterface() {
  const item = currentItem();
  const hasItems = state.items.length > 0;
  elements.dropZone.hidden = hasItems;
  elements.imageMeta.hidden = !item;
  elements.queueSection.hidden = !hasItems;
  elements.removeCurrent.disabled = !item;
  elements.downloadCurrent.disabled = !item;
  elements.downloadAll.disabled = !hasItems;
  elements.queueCount.textContent = String(state.items.length);
  elements.downloadCount.textContent = hasItems ? `(${state.items.length})` : "";
  elements.selectedName.textContent = item ? item.file.name : "Добавьте фотографию";
  renderFileList();
}

function selectItem(id) {
  if (!state.items.some((item) => item.id === id)) return;
  state.currentId = id;
  state.currentPreviewBlob = null;
  updateInterface();
  schedulePreview();
}

function addFiles(fileList) {
  const files = [...fileList];
  let rejected = 0;
  const existingKeys = new Set(state.items.map((item) => `${item.file.name}:${item.file.size}:${item.file.lastModified}`));

  files.forEach((file) => {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (!SUPPORTED_TYPES.has(file.type) || existingKeys.has(key)) {
      rejected += 1;
      return;
    }
    existingKeys.add(key);
    state.items.push({
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      file,
      url: URL.createObjectURL(file),
      bitmap: null,
    });
  });

  if (!state.currentId && state.items.length) state.currentId = state.items[0].id;
  updateInterface();
  schedulePreview();
  if (rejected) showToast("Некоторые файлы пропущены: поддерживаются JPEG, PNG и WEBP");
}

function disposeItem(item) {
  URL.revokeObjectURL(item.url);
  if (item.bitmap && typeof item.bitmap.close === "function") item.bitmap.close();
}

function removeCurrent() {
  const index = state.items.findIndex((item) => item.id === state.currentId);
  if (index < 0) return;
  const [removed] = state.items.splice(index, 1);
  disposeItem(removed);
  const next = state.items[Math.min(index, state.items.length - 1)] ?? null;
  state.currentId = next?.id ?? null;
  state.previewToken += 1;
  updateInterface();
  if (next) schedulePreview();
}

function clearAll() {
  state.items.forEach(disposeItem);
  state.items = [];
  state.currentId = null;
  state.currentPreviewBlob = null;
  state.previewToken += 1;
  updateInterface();
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function withBusyButton(button, busyText, action) {
  const original = button.innerHTML;
  button.disabled = true;
  button.textContent = busyText;
  try {
    await action();
  } finally {
    button.innerHTML = original;
    button.disabled = false;
  }
}

async function downloadCurrent() {
  const item = currentItem();
  if (!item) return;
  await withBusyButton(elements.downloadCurrent, "Обрабатываем…", async () => {
    const { blob, dimensions } = await processItem(item);
    triggerDownload(blob, safeName(item.file.name));
    if (dimensions.limited) showToast("Очень большое фото уменьшено до лимита браузера");
    else showToast("Готово — JPEG скачан");
  });
}

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let value = n;
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crcTable[n] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function setUint(view, offset, value, size) {
  if (size === 2) view.setUint16(offset, value, true);
  else view.setUint32(offset, value, true);
}

async function createZip(entries) {
  const encoder = new TextEncoder();
  const records = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = new Uint8Array(await entry.blob.arrayBuffer());
    const checksum = crc32(data);
    const local = new Uint8Array(30 + name.length + data.length);
    const view = new DataView(local.buffer);
    setUint(view, 0, 0x04034b50, 4);
    setUint(view, 4, 20, 2);
    setUint(view, 6, 0x0800, 2);
    setUint(view, 8, 0, 2);
    setUint(view, 14, checksum, 4);
    setUint(view, 18, data.length, 4);
    setUint(view, 22, data.length, 4);
    setUint(view, 26, name.length, 2);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    records.push({ name, data, checksum, offset, local });
    offset += local.length;
  }

  const centralParts = [];
  let centralSize = 0;
  for (const record of records) {
    const central = new Uint8Array(46 + record.name.length);
    const view = new DataView(central.buffer);
    setUint(view, 0, 0x02014b50, 4);
    setUint(view, 4, 20, 2);
    setUint(view, 6, 20, 2);
    setUint(view, 8, 0x0800, 2);
    setUint(view, 10, 0, 2);
    setUint(view, 16, record.checksum, 4);
    setUint(view, 20, record.data.length, 4);
    setUint(view, 24, record.data.length, 4);
    setUint(view, 28, record.name.length, 2);
    setUint(view, 42, record.offset, 4);
    central.set(record.name, 46);
    centralParts.push(central);
    centralSize += central.length;
  }

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  setUint(endView, 0, 0x06054b50, 4);
  setUint(endView, 8, records.length, 2);
  setUint(endView, 10, records.length, 2);
  setUint(endView, 12, centralSize, 4);
  setUint(endView, 16, offset, 4);
  return new Blob([...records.map((record) => record.local), ...centralParts, end], { type: "application/zip" });
}

async function downloadAll() {
  if (!state.items.length) return;
  await withBusyButton(elements.downloadAll, `Обрабатываем 0/${state.items.length}…`, async () => {
    const processed = [];
    for (let index = 0; index < state.items.length; index += 1) {
      elements.downloadAll.textContent = `Обрабатываем ${index + 1}/${state.items.length}…`;
      const item = state.items[index];
      const { blob } = await processItem(item);
      processed.push({ item, blob });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const zip = await createZip(uniqueNames(processed));
    triggerDownload(zip, "degraded_photos.zip");
    showToast(`Готово — ${state.items.length} фото собраны в ZIP`);
  });
}

elements.fileInput.addEventListener("change", (event) => {
  addFiles(event.target.files);
  event.target.value = "";
});

["dragenter", "dragover"].forEach((eventName) => {
  elements.compareArea.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    elements.dropZone.classList.add("dragging");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  elements.compareArea.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove("dragging");
  });
});

elements.compareArea.addEventListener("drop", (event) => addFiles(event.dataTransfer.files));

[elements.quality, elements.scale, elements.blur].forEach((range) => {
  range.addEventListener("input", schedulePreview);
});

elements.presets.forEach((button) => {
  button.addEventListener("click", () => {
    elements.quality.value = button.dataset.quality;
    elements.scale.value = button.dataset.scale;
    elements.blur.value = button.dataset.blur;
    schedulePreview();
  });
});

elements.resetSettings.addEventListener("click", () => {
  elements.quality.value = DEFAULTS.quality;
  elements.scale.value = DEFAULTS.scale;
  elements.blur.value = DEFAULTS.blur;
  schedulePreview();
});

elements.removeCurrent.addEventListener("click", removeCurrent);
elements.clearAll.addEventListener("click", clearAll);
elements.downloadCurrent.addEventListener("click", () => downloadCurrent().catch((error) => showToast(error.message)));
elements.downloadAll.addEventListener("click", () => downloadAll().catch((error) => showToast(error.message)));

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => currentItem() && refreshPreview(), 140);
});

window.addEventListener("beforeunload", () => state.items.forEach(disposeItem));

async function loadDemoFromQuery() {
  if (!new URLSearchParams(window.location.search).has("demo")) return;
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 800;
  const context = canvas.getContext("2d");
  const gradient = context.createLinearGradient(0, 0, 1200, 800);
  gradient.addColorStop(0, "#19352c");
  gradient.addColorStop(0.5, "#d5c77a");
  gradient.addColorStop(1, "#b45454");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 1200, 800);
  for (let index = 0; index < 160; index += 1) {
    context.fillStyle = `hsla(${index * 11}, 80%, 70%, 0.34)`;
    context.beginPath();
    context.arc((index * 83) % 1200, (index * 47) % 800, 4 + (index % 14), 0, Math.PI * 2);
    context.fill();
  }
  context.fillStyle = "rgba(255, 255, 255, 0.92)";
  context.font = "800 92px Segoe UI, sans-serif";
  context.fillText("DEMO PHOTO", 265, 425);
  const blob = await canvasToBlob(canvas, 92);
  addFiles([new File([blob], "demo-photo.jpg", { type: "image/jpeg" })]);
}

syncControls();
updateInterface();
loadDemoFromQuery();
