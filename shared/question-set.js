// This module is shared by the browser and the server. Always construct a new
// public object instead of deleting/merely hiding fields on a private one.
export const MAX_QUESTIONS = 15;
const ID = /^[A-Za-z0-9_-]{12,64}$/;
const GRID = /^(49|50)Q [A-HJ-NP-Z]{2} \d{4} \d{4}$/;
const TYPES = ['grid', 'identify', 'bearing', 'resection', 'free'];

export function validId(value) { return typeof value === 'string' && ID.test(value); }
function text(value, max, required = false) {
  return typeof value === 'string' && value.length <= max && (!required || value.trim().length > 0);
}
function point(value) {
  return value && typeof value === 'object' && Number.isFinite(value.lat) && Number.isFinite(value.lon)
    && value.lat >= 22 && value.lat <= 22.65 && value.lon >= 113.75 && value.lon <= 114.55;
}
function distant(a, b) {
  const rad = Math.PI / 180;
  const dLat = (a.lat - b.lat) * rad;
  const dLon = (a.lon - b.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(h))) >= 10;
}
function validateQuestion(input, privateAnswers) {
  if (!input || typeof input !== 'object' || !validId(input.id) || !TYPES.includes(input.type)
      || !text(input.prompt, 160, true)) return null;
  const expected = { grid: 1, identify: 0, bearing: 2, resection: 3, free: 0 }[input.type];
  if (!Array.isArray(input.points) || input.points.length !== expected || !input.points.every(point)) return null;
  if ((input.type === 'bearing' || input.type === 'resection') && input.points.some((p, i) => input.points.slice(0, i).some((other) => !distant(p, other)))) return null;
  const reference = input.reference || '';
  if (!text(reference, 32) || (input.type === 'identify' && !GRID.test(reference))
      || (input.type !== 'identify' && reference !== '')) return null;
  if (input.type === 'identify' && ((reference.startsWith('49Q ') && !/^49Q [A-H][A-HJ-NP-V] /.test(reference))
    || (reference.startsWith('50Q ') && !/^50Q [J-NP-R][A-HJ-NP-V] /.test(reference)))) return null;
  if (privateAnswers && !text(input.answer, 160, true)) return null;
  return {
    id: input.id, type: input.type, prompt: input.prompt.trim(), reference,
    points: input.points.map(({ lat, lon }) => ({ lat, lon })),
    ...(privateAnswers ? { answer: input.answer.trim(),
      ...(input.type === 'bearing' && ['auto', 'manual'].includes(input.answerMode) ? { answerMode: input.answerMode } : {}) } : {}),
  };
}

export function validateQuestionSet(input, { privateAnswers = false } = {}) {
  if (!input || typeof input !== 'object' || !validId(input.id) || !text(input.name, 48, true)
    || !Number.isSafeInteger(input.revision) || input.revision < 1 || input.revision > 1000000000
    || !Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > MAX_QUESTIONS) return null;
  const questions = input.questions.map((q) => validateQuestion(q, privateAnswers));
  if (questions.some((q) => !q) || new Set(questions.map((q) => q.id)).size !== questions.length) return null;
  return { id: input.id, name: input.name.trim(), revision: input.revision, questions };
}

export function publicQuestionSet(input) {
  if (!validateQuestionSet(input, { privateAnswers: true })) return null;
  return validateQuestionSet(input);
}

export function answerPacket(input, questionIds = null) {
  const set = validateQuestionSet(input, { privateAnswers: true });
  if (!set) return null;
  const selected = questionIds ? new Set(questionIds) : null;
  return {
    kind: 'answers', v: 1, setId: set.id, revision: set.revision,
    answers: set.questions.filter((q) => !selected || selected.has(q.id)).map(({ id, answer }) => ({ id, answer })),
  };
}

export function validateAnswerPacket(input) {
  if (!input || input.kind !== 'answers' || input.v !== 1 || !validId(input.setId)
      || !Number.isSafeInteger(input.revision) || input.revision < 1 || input.revision > 1000000000
      || !Array.isArray(input.answers) || input.answers.length < 1 || input.answers.length > MAX_QUESTIONS
      || !input.answers.every((a) => a && validId(a.id) && text(a.answer, 160, true))
      || new Set(input.answers.map((a) => a.id)).size !== input.answers.length) return null;
  return { kind: 'answers', v: 1, setId: input.setId, revision: input.revision,
    answers: input.answers.map(({ id, answer }) => ({ id, answer: answer.trim() })) };
}
