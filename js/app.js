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
// Replace Leaflet's default attribution prefix (which shows a Ukrainian-flag
// logo) with a plain text link, keeping the required library credit.
map.attributionControl.setPrefix(
  '<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>'
);
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

// ---- City quick-navigation dropdown (always visible in the panel) ----
const cityNavSelect = document.getElementById("cityNavSelect");
if (cityNavSelect) {
  [...RUSSIA_CITIES]
    .sort((a, b) => a.name.localeCompare(b.name, "ru"))
    .forEach((c) => {
      const opt = document.createElement("option");
      opt.value = `${c.lat},${c.lng}`;
      opt.textContent = c.name;
      cityNavSelect.appendChild(opt);
    });
  cityNavSelect.addEventListener("change", () => {
    if (!cityNavSelect.value) return;
    const [lat, lng] = cityNavSelect.value.split(",").map(Number);
    map.setView([lat, lng], 11);
    if (window.innerWidth <= 720) panelEl.classList.remove("open");
  });
}

// ---- Geolocation: "locate me" (panel button + on-map control) ----
let youAreHereMarker = null;
function locateUser() {
  if (!navigator.geolocation) {
    alert("Геолокация не поддерживается вашим браузером.");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      map.setView([latitude, longitude], 13);
      if (youAreHereMarker) youAreHereMarker.remove();
      youAreHereMarker = L.marker([latitude, longitude])
        .addTo(map)
        .bindPopup("Вы здесь")
        .openPopup();
      if (window.innerWidth <= 720) panelEl.classList.remove("open");
    },
    () =>
      alert(
        "Не удалось определить местоположение. Разрешите доступ к геолокации в браузере."
      )
  );
}

const locateMeBtn = document.getElementById("locateMeBtn");
if (locateMeBtn) locateMeBtn.addEventListener("click", locateUser);

const LocateControl = L.Control.extend({
  options: { position: "topleft" },
  onAdd() {
    const btn = L.DomUtil.create("button", "locate-control");
    btn.type = "button";
    btn.title = "Найти меня";
    btn.textContent = "📍";
    L.DomEvent.disableClickPropagation(btn);
    L.DomEvent.on(btn, "click", locateUser);
    return btn;
  },
});
map.addControl(new LocateControl());

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

// ---- Fuel stations from OpenStreetMap (Overpass API) ----
// When the map is zoomed into a city, load real fuel stations (amenity=fuel)
// so users can click a station and report its status without typing coords.
const poiLayer = L.layerGroup().addTo(map);
const fuelIcon = L.divIcon({
  className: "fuel-poi",
  html: "⛽",
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});
let poiFetchTimer = null;
let lastPoiKey = "";

function openReportForStation(lat, lng, name, tags) {
  reportFormSection.hidden = false;
  document.getElementById("latInput").value = lat.toFixed(4);
  document.getElementById("lngInput").value = lng.toFixed(4);
  const addressEl = document.getElementById("addressInput");
  if (addressEl && !addressEl.value) addressEl.value = name;
  const cityEl = document.getElementById("cityInput");
  if (cityEl && tags && tags["addr:city"] && !cityEl.value) {
    cityEl.value = tags["addr:city"];
  }
  if (window.innerWidth <= 720) panelEl.classList.add("open");
  reportFormSection.scrollIntoView({ behavior: "smooth" });
}

async function loadFuelStations() {
  if (map.getZoom() < 12) {
    poiLayer.clearLayers();
    lastPoiKey = "";
    return;
  }
  const b = map.getBounds();
  const s = b.getSouth().toFixed(3);
  const w = b.getWest().toFixed(3);
  const n = b.getNorth().toFixed(3);
  const e = b.getEast().toFixed(3);
  const key = `${s},${w},${n},${e}`;
  if (key === lastPoiKey) return;
  lastPoiKey = key;
  const query = `[out:json][timeout:25];node["amenity"="fuel"](${s},${w},${n},${e});out body 300;`;
  try {
    const resp = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      body: "data=" + encodeURIComponent(query),
    });
    const data = await resp.json();
    poiLayer.clearLayers();
    (data.elements || []).forEach((el) => {
      if (!el.lat || !el.lon) return;
      const name =
        el.tags?.name || el.tags?.brand || el.tags?.operator || "АЗС";
      const marker = L.marker([el.lat, el.lon], { icon: fuelIcon });
      marker.bindTooltip(name, { direction: "top" });
      marker.on("click", () =>
        openReportForStation(el.lat, el.lon, name, el.tags)
      );
      marker.addTo(poiLayer);
    });
  } catch (err) {
    console.warn("Не удалось загрузить АЗС из OpenStreetMap:", err);
  }
}

map.on("moveend", () => {
  clearTimeout(poiFetchTimer);
  poiFetchTimer = setTimeout(loadFuelStations, 600);
});
loadFuelStations();

// Periodically re-render so "stale" state and time-ago labels stay fresh.
setInterval(renderMarkers, 60000);
