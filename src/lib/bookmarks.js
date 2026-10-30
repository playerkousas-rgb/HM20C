// Bookmarks are manually chosen map centres, never device locations.
export const BOOKMARKS_KEY = 'scout-trail-map.bookmarks.v1';
export const MAX_BOOKMARKS = 50;
export const MAX_BOOKMARK_NAME = 40;
const MAX_LAT = 85.05112878; // Leaflet's Web Mercator limit

function normaliseBookmark(item) {
  if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 100 ||
      typeof item.name !== 'string' || !item.name.trim() || item.name.trim().length > MAX_BOOKMARK_NAME ||
      !Number.isFinite(item.lat) || Math.abs(item.lat) > MAX_LAT ||
      !Number.isFinite(item.lon) || Math.abs(item.lon) > 180) return null;
  return { id: item.id, name: item.name.trim(), lat: item.lat, lon: item.lon };
}

export function makeBookmark(center, name) {
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return normaliseBookmark({
    id, name,
    lat: Number(center?.lat?.toFixed?.(7)),
    lon: Number(center?.lon?.toFixed?.(7)),
  });
}

export function loadBookmarks() {
  try {
    const saved = JSON.parse(localStorage.getItem(BOOKMARKS_KEY));
    if (!Array.isArray(saved)) return [];
    const seen = new Set();
    return saved.map(normaliseBookmark).filter((item) => {
      if (!item || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    }).slice(0, MAX_BOOKMARKS);
  } catch { return []; }
}

export function saveBookmarks(bookmarks) {
  if (!Array.isArray(bookmarks) || bookmarks.length > MAX_BOOKMARKS) return false;
  const values = bookmarks.map(normaliseBookmark);
  if (values.some((item) => !item) || new Set(values.map((item) => item.id)).size !== values.length) return false;
  try {
    localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(values));
    return true;
  } catch { return false; }
}
