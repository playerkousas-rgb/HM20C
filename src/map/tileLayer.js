import * as L from 'leaflet';

// The LandsD terms discourage large bursts. All visible basemap/label tiles share
// this small queue; unneeded tiles are cancelled when the user pans or switches
// maps. The separate, user-initiated offline downloader is capped and paced.
const MAX_IN_FLIGHT = 6;
const TIMEOUT_MS = 15000;
const pending = [];
const active = new Set();
const tasksByTile = new WeakMap();

function pump() {
  while (active.size < MAX_IN_FLIGHT && pending.length) {
    const task = pending.shift();
    if (task.finished) continue;
    active.add(task);
    const { tile, url } = task;
    tile.onload = () => finish(task, null);
    tile.onerror = () => finish(task, new Error('tile load failed'));
    task.timer = setTimeout(() => {
      tile.onload = null;
      tile.onerror = null;
      tile.removeAttribute('src');
      finish(task, new Error('tile load timed out'));
    }, TIMEOUT_MS);
    tile.src = url;
  }
}

function finish(task, error, cancelled = false) {
  if (task.finished) return;
  task.finished = true;
  clearTimeout(task.timer);
  active.delete(task);
  task.tile.onload = null;
  task.tile.onerror = null;
  tasksByTile.delete(task.tile);
  if (!cancelled) task.done(error, task.tile);
  pump();
}

function cancelTile(tile) {
  const task = tasksByTile.get(tile);
  if (task) finish(task, null, true);
}

export const QueuedTileLayer = L.TileLayer.extend({
  initialize(url, options) {
    L.TileLayer.prototype.initialize.call(this, url, options);
    this.on('tileunload tileabort', (event) => cancelTile(event.tile));
  },
  createTile(coords, done) {
    const tile = document.createElement('img');
    tile.alt = '';
    if (this.options.crossOrigin || this.options.crossOrigin === '') {
      tile.crossOrigin = this.options.crossOrigin === true ? '' : this.options.crossOrigin;
    }
    if (typeof this.options.referrerPolicy === 'string') tile.referrerPolicy = this.options.referrerPolicy;
    const task = { tile, done, url: this.getTileUrl(coords), finished: false, timer: null };
    tasksByTile.set(tile, task);
    pending.push(task);
    pump();
    return tile;
  },
});
