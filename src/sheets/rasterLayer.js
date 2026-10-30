import * as L from 'leaflet';

const TILE_SIZE = 256;
const STEP = 16;
const NODES = TILE_SIZE / STEP + 1;
const MAX_READ_BYTES = 32 * 1024 * 1024;
const MAX_IN_FLIGHT_BLOCK_BYTES = 24 * 1024 * 1024;

export function worldPixelToLonLat(x, y, z) {
  const world = TILE_SIZE * 2 ** z;
  return [(x / world) * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y / world))) * 180 / Math.PI];
}

function buildGrid(geometry, coords) {
  const xs = new Float64Array(NODES * NODES), ys = new Float64Array(NODES * NODES);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let y = 0; y < NODES; y += 1) for (let x = 0; x < NODES; x += 1) {
    const lonlat = worldPixelToLonLat(coords.x * TILE_SIZE + x * STEP, coords.y * TILE_SIZE + y * STEP, coords.z);
    const [px, py] = geometry.toPixel(lonlat);
    const index = y * NODES + x;
    xs[index] = px; ys[index] = py;
    minX = Math.min(minX, px); maxX = Math.max(maxX, px);
    minY = Math.min(minY, py); maxY = Math.max(maxY, py);
  }
  return { xs, ys, minX, minY, maxX, maxY };
}

function ensureActive(signal, tile) {
  if (signal.aborted || tile._discard) throw new DOMException('Tile no longer needed', 'AbortError');
}

// geotiff.js reads the source window at native resolution even when an output
// width/height is requested. Bound both its working array and the sum of its
// simultaneously decoded strips, instead of decoding an entire 12 km sheet.
async function readWindow(image, window, signal, tile) {
  const directory = image.getFileDirectory();
  const sourceW = window[2] - window[0], sourceH = window[3] - window[1];
  const bits = [...directory.BitsPerSample], sampleCount = image.getSamplesPerPixel();
  const bytesPerPixel = Math.ceil(Math.max(...bits) / 8) * sampleCount;
  if (sourceW * sourceH * bytesPerPixel > MAX_READ_BYTES) throw new Error('此圖幅在鎖定比例下的解碼範圍過大，手機試用版未支援。');
  const outW = Math.min(sourceW, 512), outH = Math.min(sourceH, 512);
  const pixels = new Uint8ClampedArray(outW * outH * 4);
  const blockW = image.getTileWidth(), blockH = image.getTileHeight();
  const blockBytes = blockW * Math.min(blockH, image.getHeight()) * bytesPerPixel;
  const blocksX = Math.ceil(window[2] / blockW) - Math.floor(window[0] / blockW);
  if (blocksX * blockBytes > 64 * 1024 * 1024) throw new Error('圖幅單行解碼區塊過大，手機試用版未支援。');
  const blocksPerSlice = Math.max(1, Math.floor(MAX_IN_FLIGHT_BLOCK_BYTES / Math.max(1, blocksX * blockBytes)));
  const rgb = directory.PhotometricInterpretation === 2;
  const associated = Number(directory.ExtraSamples?.[0]) === 1;
  const scale = (value, band) => rgb ? Math.round(value * 255 / (2 ** (bits[band] || bits[0]) - 1)) : value;

  for (let y = 0; y < outH;) {
    ensureActive(signal, tile);
    const sourceY = Math.floor(y * sourceH / outH);
    // Keep each read inside a bounded number of whole TIFF blocks, accounting
    // for an unaligned window. A single large strip is decoded once rather
    // than once for every output row.
    const absoluteY = window[1] + sourceY;
    const blockEnd = (Math.floor(absoluteY / blockH) + blocksPerSlice) * blockH;
    const maxSourceY = Math.min(sourceH, blockEnd - window[1]);
    let endY = Math.min(outH, Math.floor(maxSourceY * outH / sourceH));
    if (endY <= y) endY = y + 1;
    let sourceEndY = Math.min(sourceH, Math.max(sourceY + 1, Math.ceil(endY * sourceH / outH)));
    // At extreme downsampling one target pixel may span a block boundary;
    // nearest-neighbour needs only the first source row in that case.
    if (endY === y + 1 && sourceEndY > maxSourceY) sourceEndY = sourceY + 1;
    // geotiff.js 2.x attaches a permanent abort listener for every FileReader
    // slice. Avoid leaking thousands of listeners during long pans: bounded
    // reads finish, then ensureActive discards work from a removed tile/layer.
    const band = await image.readRGB({
      window: [window[0], window[1] + sourceY, window[2], window[1] + sourceEndY],
      width: outW, height: endY - y, enableAlpha: true,
    });
    ensureActive(signal, tile);
    const channels = band.length / (outW * (endY - y));
    if (channels !== 3 && channels !== 4) throw new Error('此 TIFF 色彩通道暫未支援。');
    for (let i = 0; i < outW * (endY - y); i += 1) {
      const src = i * channels, dst = (y * outW + i) * 4;
      const alpha = channels === 4 ? scale(band[src + 3], 3) : 255;
      const unpremultiply = associated && alpha > 0 ? 255 / alpha : 1;
      pixels[dst] = Math.min(255, scale(band[src], 0) * unpremultiply);
      pixels[dst + 1] = Math.min(255, scale(band[src + 1], 1) * unpremultiply);
      pixels[dst + 2] = Math.min(255, scale(band[src + 2], 2) * unpremultiply);
      pixels[dst + 3] = alpha;
    }
    y = endY;
  }
  return { data: pixels, width: outW, height: outH };
}

async function drawTile(tile, coords, geometry, image, signal) {
  ensureActive(signal, tile);
  const topLeft = worldPixelToLonLat(coords.x * TILE_SIZE, coords.y * TILE_SIZE, coords.z);
  const bottomRight = worldPixelToLonLat((coords.x + 1) * TILE_SIZE, (coords.y + 1) * TILE_SIZE, coords.z);
  const bounds = geometry.bounds;
  if (bottomRight[0] < bounds.west || topLeft[0] > bounds.east || topLeft[1] < bounds.south || bottomRight[1] > bounds.north) return;
  const grid = buildGrid(geometry, coords);
  const window = [
    Math.max(0, Math.floor(grid.minX) - 2), Math.max(0, Math.floor(grid.minY) - 2),
    Math.min(geometry.width, Math.ceil(grid.maxX) + 2), Math.min(geometry.height, Math.ceil(grid.maxY) + 2),
  ];
  if (window[0] >= window[2] || window[1] >= window[3]) return;
  const source = await readWindow(image, window, signal, tile);
  const ctx = tile.getContext('2d');
  if (!ctx) throw new Error('手機未能建立地圖畫布。');
  const output = ctx.createImageData(TILE_SIZE, TILE_SIZE);
  const width = window[2] - window[0], height = window[3] - window[1];
  for (let y = 0; y < TILE_SIZE; y += 1) {
    if (y % 32 === 0) ensureActive(signal, tile);
    const gridRow = Math.floor(y / STEP), fy = (y + 0.5) / STEP - gridRow;
    for (let column = 0; column < TILE_SIZE / STEP; column += 1) {
      // Interpolate the projected 16-pixel grid one span at a time. Avoid an
      // array/closure per screen pixel to reduce garbage collection on phones.
      const i = gridRow * NODES + column;
      const leftX = grid.xs[i] * (1 - fy) + grid.xs[i + NODES] * fy;
      const rightX = grid.xs[i + 1] * (1 - fy) + grid.xs[i + NODES + 1] * fy;
      const leftY = grid.ys[i] * (1 - fy) + grid.ys[i + NODES] * fy;
      const rightY = grid.ys[i + 1] * (1 - fy) + grid.ys[i + NODES + 1] * fy;
      const stepX = (rightX - leftX) / STEP, stepY = (rightY - leftY) / STEP;
      let px = leftX + stepX / 2, py = leftY + stepY / 2;
      for (let x = column * STEP; x < (column + 1) * STEP; x += 1, px += stepX, py += stepY) {
        if (px < 0 || py < 0 || px >= geometry.width || py >= geometry.height) continue;
        const sx = Math.min(source.width - 1, Math.max(0, Math.floor((px - window[0]) * source.width / width)));
        const sy = Math.min(source.height - 1, Math.max(0, Math.floor((py - window[1]) * source.height / height)));
        const src = (sy * source.width + sx) * 4, dst = (y * TILE_SIZE + x) * 4;
        output.data[dst] = source.data[src]; output.data[dst + 1] = source.data[src + 1];
        output.data[dst + 2] = source.data[src + 2]; output.data[dst + 3] = source.data[src + 3];
      }
    }
  }
  ctx.putImageData(output, 0, 0);
}

class LimitedQueue {
  constructor(limit) { this.limit = limit; this.running = 0; this.tasks = []; }
  add(run) {
    return new Promise((resolve, reject) => { this.tasks.push({ run, resolve, reject }); this.next(); });
  }
  next() {
    while (this.running < this.limit && this.tasks.length) {
      const task = this.tasks.shift();
      this.running += 1;
      Promise.resolve().then(task.run).then(task.resolve, task.reject).finally(() => { this.running -= 1; this.next(); });
    }
  }
}

const SheetLayer = L.GridLayer.extend({
  initialize(image, geometry, options) {
    L.GridLayer.prototype.initialize.call(this, options);
    this.image = image;
    this.geometry = geometry;
    this.controller = new AbortController();
    this.queue = new LimitedQueue(2);
    this.on('tileunload', (event) => { event.tile._discard = true; });
  },
  createTile(coords, done) {
    const tile = L.DomUtil.create('canvas', 'sheet-raster-tile');
    tile.width = TILE_SIZE; tile.height = TILE_SIZE;
    tile.dataset.x = String(coords.x); tile.dataset.y = String(coords.y); tile.dataset.z = String(coords.z);
    this.queue.add(() => drawTile(tile, coords, this.geometry, this.image, this.controller.signal)).then(
      () => done(null, tile),
      (error) => { if (error?.name === 'AbortError') done(null, tile); else done(error, tile); },
    );
    return tile;
  },
  onRemove(map) {
    this.controller.abort();
    L.GridLayer.prototype.onRemove.call(this, map);
  },
});

export function createSheetLayer(image, geometry) {
  return new SheetLayer(image, geometry, { tileSize: TILE_SIZE, noWrap: true, minZoom: 10, maxZoom: 20, keepBuffer: 1, updateWhenIdle: true });
}
