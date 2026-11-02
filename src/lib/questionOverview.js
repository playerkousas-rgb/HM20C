import { bearingAnswers, formatBearing } from './bearing';
import { gridReference, parseGridReference } from './utm';

// Older bearing questions had only a free-text answer. Keep those manual;
// newly-created questions default to the live, recalculated grid bearing.
export function bearingAnswerMode(question) {
  return question.answerMode === 'auto' || question.answerMode === 'manual'
    ? question.answerMode : (question.answer?.trim() ? 'manual' : 'auto');
}
export function calculatedBearingAnswer(question) {
  if (question.type !== 'bearing' || question.points?.length !== 2) return '';
  const b = bearingAnswers(question.points[0], question.points[1]);
  return b ? `方格北前視 ${formatBearing(b.forwardGrid)}；後視 ${formatBearing(b.backGrid)}（${b.zone}Q，約值）` : '';
}
export function leaderAnswer(question) {
  if (question.type === 'grid') return gridReference(question.points?.[0])?.text || '';
  if (question.type === 'bearing' && bearingAnswerMode(question) === 'auto') return calculatedBearingAnswer(question);
  return question.answer?.trim() || '';
}

// Construct only the information allowed for the current viewer. An omitted
// answer map means a private leader draft; member maps must pass released IDs.
export function questionOverviewItems(set, releasedAnswers = null) {
  if (!set || !Array.isArray(set.questions)) return [];
  const released = releasedAnswers === null ? null : new Map(releasedAnswers.map((a) => [a.id, a.answer]));
  return set.questions.map((q, index) => {
    const answer = released ? (released.get(q.id) || '') : leaderAnswer(q);
    const points = Array.isArray(q.points) ? q.points : [];
    const missing = released ? '答案尚未公布' : '答案尚未填寫';
    const markers = [];
    const add = (point, suffix = '', detail = '') => {
      if (point && Number.isFinite(point.lat) && Number.isFinite(point.lon)) markers.push({ lat: point.lat, lon: point.lon, label: `${index + 1}${suffix}`, detail });
    };
    if (q.type === 'grid') add(points[0], '', answer || missing);
    if (q.type === 'identify') add(parseGridReference(q.reference), '', answer || missing);
    if (q.type === 'bearing') points.forEach((p, i) => add(p, String.fromCharCode(65 + i), i === 0 ? (answer || missing) : ''));
    if (q.type === 'resection') {
      points.forEach((p, i) => add(p, String.fromCharCode(65 + i), i === 0 ? '三角地標（非答案位置）' : ''));
      // Three landmarks alone cannot locate the observer. Only plot a supplied
      // answer if it is explicitly a complete eight-figure coordinate.
      const answerPoint = parseGridReference(answer);
      if (answerPoint) add(answerPoint, '★', `答案格中心：${answerPoint.text}`);
    }
    return { id: q.id, index, prompt: q.prompt || `第 ${index + 1} 題`, answer,
      markers, line: q.type === 'bearing' && points.length === 2 ? points : null,
      target: markers.find((marker) => marker.label.endsWith('★')) || markers[0] || null };
  });
}
