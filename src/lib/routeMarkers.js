// Consecutive snap strokes are stored as separate GPX segments for atomic undo.
// Their shared endpoints are a single intermediate marker, not a new start.
// Distinct imported GPX segments with gaps remain separate chains.
function samePosition(a, b) {
  return a && b && Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lon - b.lon) < 1e-9;
}

export function routeMarkers(route) {
  const chains = [];
  for (const segment of route.segments) {
    if (!segment.points.length) continue;
    const start = segment.points[0];
    const end = segment.points.at(-1);
    let chain = chains.at(-1);
    if (!chain || !samePosition(chain.at(-1), start)) {
      chain = [start];
      chains.push(chain);
    }
    if (segment.points.length > 1) chain.push(end);
  }
  return chains.flatMap((chain) => {
    if (chain.length === 1) return [{ point: chain[0], type: 'start', label: '起' }];
    if (chain.length === 2 && samePosition(chain[0], chain[1])) {
      return [{ point: chain[0], type: 'start', label: '起終' }];
    }
    return chain.map((point, index) => ({
      point,
      type: index === 0 ? 'start' : index === chain.length - 1 ? 'end' : 'via',
      label: index === 0 ? '起' : index === chain.length - 1 ? '終' : String(index),
    }));
  });
}
