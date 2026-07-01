import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  getDoc,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { RUSSIA_CITIES } from "./cities.js";

const STALE_MS = 24 * 3600 * 1000;
const FUEL_LABELS = { 92: "АИ-92", 95: "АИ-95", 98: "АИ-98", dt: "ДТ", gas: "Газ" };
const STATUS_LABELS = {
  available: "Есть в наличии",
  queue: "Есть, но очередь",
  limited: "Ограничение отпуска",
  none: "Топлива нет",
};
const STATUS_COLORS = {
  available: "#2ecc71",
  queue: "#f1c40f",
  limited: "#e67e22",
  none: "#e74c3c",
};
const STALE_COLOR = "#9aa0a6";
const LOCAL_STORAGE_KEY = "fuelmap_local_reports_v1";
const REPORTER_ID_KEY = "fuelmap_reporter_id";

const setupNoticeEl = document.getElementById("setupNotice");

function isFirebaseConfigured(cfg) {
  return Boolean(cfg.apiKey) && !cfg.apiKey.startsWith("YOUR_");
}

const configured = isFirebaseConfigured(firebaseConfig);
let db = null;

if (configured) {
  const fbApp = initializeApp(firebaseConfig);
  db = getFirestore(fbApp);
} else {
  setupNoticeEl.innerHTML =
    '<p class="warn">⚠️ Firebase не настроен. Отчёты сохраняются только локально в этом браузере и не видны другим пользователям. Инструкция по настройке — в README.md.</p>';
}

function getReporterId() {
  let id = localStorage.getItem(REPORTER_ID_KEY);
  if (!id) {
    id = "r-" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem(REPORTER_ID_KEY, id);
  }
  return id;
}

function loadLocalReports() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveLocalReports(data) {
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(data));
}

// ---- Map setup ----
const map = L.map("map", { zoomControl: true }).setView([61, 90], 3);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
  maxZoom: 18,
}).addTo(map);

const markersLayer = L.layerGroup().addTo(map);
let stationsData = {};

// ---- City datalist ----
const cityListEl = document.getElementById("cityList");
RUSSIA_CITIES.forEach((c) => {
  const opt = document.createElement("option");
  opt.value = c.name;
  cityListEl.appendChild(opt);
});

document.getElementById("cityInput").addEventListener("change", (e) => {
  const match = RUSSIA_CITIES.find(
    (c) => c.name.toLowerCase() === e.target.value.trim().toLowerCase()
  );
  if (match) {
    map.setView([match.lat, match.lng], 11);
    const latEl = document.getElementById("latInput");
    const lngEl = document.getElementById("lngInput");
    if (!latEl.value) latEl.value = match.lat.toFixed(4);
    if (!lngEl.value) lngEl.value = match.lng.toFixed(4);
  }
});

// ---- Helpers ----
function toMillis(ts) {
  if (!ts) return null;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts === "number") return ts;
  return null;
}

function isStale(updatedAt) {
  const ms = toMillis(updatedAt);
  if (!ms) return true;
  return Date.now() - ms > STALE_MS;
}

function timeAgo(ms) {
  if (!ms) return "нет данных";
  const diff = Math.max(0, Date.now() - ms);
  const min = Math.floor(diff / 60000);
  if (min < 1) return "только что";
  if (min < 60) return `${min} мин. назад`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs} ч. назад`;
  const days = Math.floor(hrs / 24);
  return `${days} дн. назад`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function activeFuelFilters() {
  return Array.from(document.querySelectorAll(".fuel-filter"))
    .filter((cb) => cb.checked)
    .map((cb) => cb.value);
}

document.querySelectorAll(".fuel-filter").forEach((cb) =>
  cb.addEventListener("change", renderMarkers)
);

function renderPopup(s, stale) {
  const fuels =
    Object.entries(s.fuelTypes || {})
      .filter(([, v]) => v)
      .map(([k]) => FUEL_LABELS[k] || k)
      .join(", ") || "—";
  const updated = timeAgo(toMillis(s.updatedAt));
  return `
    <div class="popup">
      <strong>${escapeHtml(s.city || "")}${s.address ? " — " + escapeHtml(s.address) : ""}</strong><br/>
      Статус: <b>${STATUS_LABELS[s.status] || s.status}</b><br/>
      Топливо: ${escapeHtml(fuels)}<br/>
      ${s.queueCars ? `Очередь: ~${Number(s.queueCars)} машин<br/>` : ""}
      ${s.note ? `Комментарий: ${escapeHtml(s.note)}<br/>` : ""}
      <small>${stale ? "⚠️ Устарело · " : ""}Обновлено: ${updated} · отчётов: ${s.reportCount || 1}</small>
    </div>`;
}

function renderMarkers() {
  markersLayer.clearLayers();
  const activeFuels = activeFuelFilters();
  let freshCount = 0;

  Object.values(stationsData).forEach((s) => {
    if (
      activeFuels.length &&
      activeFuels.length < Object.keys(FUEL_LABELS).length
    ) {
      const hasAny = activeFuels.some((f) => s.fuelTypes && s.fuelTypes[f]);
      if (!hasAny) return;
    }
    const stale = isStale(s.updatedAt);
    const color = stale ? STALE_COLOR : STATUS_COLORS[s.status] || STALE_COLOR;
    const marker = L.circleMarker([s.lat, s.lng], {
      radius: 9,
      fillColor: color,
      color: "#333",
      weight: 1,
      fillOpacity: stale ? 0.35 : 0.9,
    });
    marker.bindPopup(renderPopup(s, stale));
    marker.addTo(markersLayer);
    if (!stale) freshCount++;
  });

  document.getElementById("reportCount").textContent = freshCount;
}

// ---- Data source: Firestore (online) or localStorage (fallback) ----
if (db) {
  onSnapshot(collection(db, "stations"), (snap) => {
    const next = {};
    snap.forEach((d) => (next[d.id] = d.data()));
    stationsData = next;
    renderMarkers();
  });
} else {
  stationsData = loadLocalReports();
  renderMarkers();
}

// ---- Add-report form ----
const panelEl = document.getElementById("panel");
const reportFormSection = document.getElementById("reportForm");
const stationForm = document.getElementById("stationForm");
const formMsgEl = document.getElementById("formMsg");
const statusInput = document.getElementById("statusInput");
const queueCarsWrap = document.getElementById("queueCarsWrap");

document.getElementById("toggleAddBtn").addEventListener("click", () => {
  reportFormSection.hidden = !reportFormSection.hidden;
  if (window.innerWidth <= 720) panelEl.classList.add("open");
  if (!reportFormSection.hidden) reportFormSection.scrollIntoView({ behavior: "smooth" });
});

document.getElementById("cancelFormBtn").addEventListener("click", () => {
  reportFormSection.hidden = true;
  stationForm.reset();
  formMsgEl.textContent = "";
});

document.getElementById("togglePanelBtn").addEventListener("click", () => {
  panelEl.classList.toggle("open");
});

statusInput.addEventListener("change", () => {
  queueCarsWrap.hidden = statusInput.value !== "queue";
});

let pickMode = false;
document.getElementById("pickOnMapBtn").addEventListener("click", () => {
  pickMode = true;
  formMsgEl.textContent = "Кликните на карте, чтобы указать местоположение АЗС.";
  formMsgEl.className = "";
  if (window.innerWidth <= 720) panelEl.classList.remove("open");
});

map.on("click", (e) => {
  if (!pickMode) return;
  document.getElementById("latInput").value = e.latlng.lat.toFixed(4);
  document.getElementById("lngInput").value = e.latlng.lng.toFixed(4);
  pickMode = false;
  formMsgEl.textContent = "Координаты установлены.";
  formMsgEl.className = "ok";
  if (window.innerWidth <= 720) panelEl.classList.add("open");
});

document.getElementById("useLocationBtn").addEventListener("click", () => {
  if (!navigator.geolocation) {
    formMsgEl.textContent = "Геолокация не поддерживается браузером.";
    formMsgEl.className = "error";
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      document.getElementById("latInput").value = pos.coords.latitude.toFixed(4);
      document.getElementById("lngInput").value = pos.coords.longitude.toFixed(4);
      map.setView([pos.coords.latitude, pos.coords.longitude], 13);
    },
    () => {
      formMsgEl.textContent = "Не удалось получить местоположение.";
      formMsgEl.className = "error";
    }
  );
});

stationForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  formMsgEl.textContent = "Отправка...";
  formMsgEl.className = "";

  const lat = parseFloat(document.getElementById("latInput").value);
  const lng = parseFloat(document.getElementById("lngInput").value);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 30 || lat > 82) {
    formMsgEl.textContent = "Укажите корректные координаты в пределах России.";
    formMsgEl.className = "error";
    return;
  }

  const fuelTypes = {};
  document
    .querySelectorAll('#stationForm input[name="fuel"]:checked')
    .forEach((cb) => (fuelTypes[cb.value] = true));

  const city = document.getElementById("cityInput").value.trim().slice(0, 100);
  const address = document.getElementById("addressInput").value.trim().slice(0, 120);
  const status = statusInput.value;
  const queueCars = statusInput.value === "queue"
    ? parseInt(document.getElementById("queueCarsInput").value, 10) || null
    : null;
  const note = document.getElementById("noteInput").value.trim().slice(0, 200);

  if (!city) {
    formMsgEl.textContent = "Укажите город.";
    formMsgEl.className = "error";
    return;
  }

  const id = `${lat.toFixed(3)}_${lng.toFixed(3)}`;
  const reporterId = getReporterId();

  const payload = {
    city,
    address,
    lat,
    lng,
    fuelTypes,
    status,
    queueCars,
    note,
    lastReporter: reporterId,
    updatedAt: db ? serverTimestamp() : Date.now(),
  };

  try {
    if (db) {
      const ref = doc(db, "stations", id);
      const existing = await getDoc(ref);
      const reportCount = existing.exists() ? (existing.data().reportCount || 1) + 1 : 1;
      const createdAt = existing.exists() ? existing.data().createdAt : serverTimestamp();
      await setDoc(ref, { ...payload, reportCount, createdAt }, { merge: true });
    } else {
      const local = loadLocalReports();
      const reportCount = local[id] ? (local[id].reportCount || 1) + 1 : 1;
      local[id] = { ...payload, reportCount, createdAt: local[id]?.createdAt || Date.now() };
      saveLocalReports(local);
      stationsData = local;
      renderMarkers();
    }
    formMsgEl.textContent = "Спасибо! Отчёт добавлен на карту.";
    formMsgEl.className = "ok";
    stationForm.reset();
    queueCarsWrap.hidden = true;
    setTimeout(() => {
      reportFormSection.hidden = true;
    }, 1200);
  } catch (err) {
    console.error(err);
    formMsgEl.textContent = "Ошибка отправки. Попробуйте ещё раз.";
    formMsgEl.className = "error";
  }
});

// Periodically re-render so "stale" state and time-ago labels stay fresh.
setInterval(renderMarkers, 60000);
