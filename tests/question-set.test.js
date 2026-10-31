import QRCode from 'qrcode';
import { deflate } from 'pako';
import { describe, expect, it } from 'vitest';
import { answerPacket, publicQuestionSet, validateAnswerPacket, validateQuestionSet } from '../shared/question-set.js';
import { answerShare, decodeShared, questionAsExercise, questionShare } from '../src/lib/questionSet.js';
const set = { id: '0123456789abcdef', name: '測試套題', revision: 4, questions: [
  { id: '1111111111111111', type: 'grid', prompt: '八位座標？', reference: '', points: [{ lat: 22.38, lon: 114.32 }], answer: '秘密格號' },
  { id: '2222222222222222', type: 'identify', prompt: '地點？', reference: '50Q KK 2430 7773', points: [], answer: '秘密圖例' },
] };
describe('question sets and independent answer packets', () => {
  it('strips all answers, including unexpected nested fields', () => {
    const publicSet = publicQuestionSet({ ...set, secret: 'hidden', questions: set.questions.map((q) => ({ ...q, secret: 'hidden', points: q.points.map((p) => ({ ...p, answer: 'hidden' })) })) });
    expect(JSON.stringify(publicSet)).not.toContain('秘密');
    expect(JSON.stringify(publicSet)).not.toContain('hidden');
    expect(publicSet.questions).toHaveLength(2);
    expect(validateQuestionSet({ ...set, questions: [...set.questions, set.questions[0]] }, { privateAnswers: true })).toBeNull();
    expect(validateQuestionSet({ ...set, questions: [{ ...set.questions[1], reference: '50Q HE 2430 7773' }] })).toBeNull();
  });
  it('fits a small multi-question set in a practical, scannable QR', () => {
    const multi = { ...set, questions: [...set.questions, { ...set.questions[1], id: '3333333333333333', prompt: '這個座標有甚麼地圖符號？' }] };
    const link = questionShare(multi);
    expect(QRCode.create(link, { errorCorrectionLevel: 'M' }).version).toBeLessThanOrEqual(17);
    expect(decodeShared(link).set.questions).toHaveLength(3);
  });
  it('displays a coordinate exercise at the centre of its 10 m cell', () => {
    const task = questionAsExercise(set.questions[1]);
    expect(task.kind).toBe('points');
    expect(task.points).toHaveLength(1);
    expect(task.points[0].lat).toBeGreaterThan(22.383496510);
    expect(JSON.stringify(task)).not.toContain('秘密圖例');
  });
  it('limits decompressed QR payloads to stop oversized compressed input', () => {
    const compressed = deflate(new TextEncoder().encode('x'.repeat(250000)));
    const value = Buffer.from(compressed).toString('base64url');
    expect(() => decodeShared(`https://example.com/#questions=z${value}`)).toThrow();
  });
  it('roundtrips separately and keeps version and question identities', () => {
    const questions = decodeShared(questionShare(set));
    expect(questions.kind).toBe('questions');
    expect(JSON.stringify(questions)).not.toContain('秘密');
    const answers = decodeShared(answerShare(set, [set.questions[1].id]));
    expect(answers).toEqual({ kind: 'answers', v: 1, setId: set.id, revision: 4, answers: [{ id: set.questions[1].id, answer: '秘密圖例' }] });
    expect(validateAnswerPacket(answerPacket(set))).toBeTruthy();
    expect(() => decodeShared('#activity=short')).toThrow();
    expect(() => decodeShared('#questions=a'.repeat(51000))).toThrow();
  });
});
