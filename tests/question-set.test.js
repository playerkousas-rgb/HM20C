import QRCode from 'qrcode';
import { deflate } from 'pako';
import { describe, expect, it } from 'vitest';
import QRCode from 'qrcode';
import { answerPacket, publicQuestionSet, validateAnswerPacket, validateQuestionSet } from '../shared/question-set.js';
import { answerShare, decodeShared, questionAsExercise, questionShare, standaloneAnswerPacket } from '../src/lib/questionSet.js';
import { bearingAnswerMode, calculatedBearingAnswer, leaderAnswer, questionOverviewItems } from '../src/lib/questionOverview.js';
import { mergeSnapshot } from '../src/hooks/useQuestionSets.js';
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
    expect(answers).toEqual({ kind: 'answers', v: 2, set: publicQuestionSet(set), answers: [{ id: set.questions[1].id, answer: '秘密圖例' }] });
    expect(JSON.stringify(answers)).not.toContain('秘密格號');
    expect(decodeShared(JSON.stringify(answerPacket(set))).v).toBe(1); // older answer-only JSON remains compatible
    const forged = standaloneAnswerPacket(set); forged.answers[0].id = 'invalidunknownid';
    expect(() => decodeShared(JSON.stringify(forged))).toThrow();
    expect(validateAnswerPacket(answerPacket(set))).toBeTruthy();
    expect(() => decodeShared('#activity=short')).toThrow();
    expect(() => decodeShared('#questions=a'.repeat(51000))).toThrow();
  });
});


describe('leader answers and temporary overview', () => {
  const bearing = { id: '3333333333333333', type: 'bearing', prompt: 'A 至 B？', reference: '', points: [{lat:22.38,lon:114.32},{lat:22.39,lon:114.33}], answer:'', answerMode:'auto' };
  it('recalculates bearings for changed points, without overwriting legacy or manual answers', () => {
    const first = leaderAnswer(bearing);
    expect(first).toMatch(/方格北前視 .*後視/);
    expect(leaderAnswer({ ...bearing, points: [bearing.points[0], {lat:22.40,lon:114.31}] })).not.toBe(first);
    expect(leaderAnswer({ ...bearing, answerMode:'manual', answer:'人工答案' })).toBe('人工答案');
    expect(bearingAnswerMode({ ...bearing, answerMode:undefined, answer:'舊答案' })).toBe('manual');
    expect(calculatedBearingAnswer({ ...bearing, points:[bearing.points[0], bearing.points[0]] })).toBe('');
    expect(JSON.stringify(publicQuestionSet({ ...set, questions:[{...bearing,answer:first}] }))).not.toContain('answerMode');
  });
  it('plots only specified resection answer coordinates and only released member answers', () => {
    const resection = { id:'4444444444444444', type:'resection', prompt:'三角', points:[bearing.points[0],bearing.points[1],{lat:22.37,lon:114.34}], answer:'50Q KK 2430 7773' };
    const data = { questions:[set.questions[0],set.questions[1],bearing,resection] };
    const leader = questionOverviewItems(data);
    expect(leader[0].markers[0].detail).toMatch(/Q/);
    expect(leader[3].markers.map((m) => m.label)).toEqual(['4A','4B','4C','4★']);
    expect(questionOverviewItems({questions:[{...resection,answer:'需要人手判斷'}]})[0].markers).toHaveLength(3);
    const member = questionOverviewItems(data, [{id:set.questions[1].id,answer:'已公布'}]);
    expect(member[0].answer).toBe('');
    expect(member[1].markers[0].detail).toBe('已公布');
    expect(member[3].markers).toHaveLength(3);
    expect(JSON.stringify(member)).not.toContain('秘密格號');
  });
});


it('does not attach network answers to a different question with the same revision', () => {
  const original = publicQuestionSet(set);
  const previous = {set:original, answers:[{id:original.questions[0].id,answer:'old'}]};
  const different = structuredClone(original); different.questions[0].prompt = '不同的題目';
  expect(mergeSnapshot(previous, {id:'x', set:different, answers:[],version:1})).toBeNull();
  expect(mergeSnapshot(previous, {id:'x', set:original, answers:[],version:1}).answers).toEqual(previous.answers);
});


it('uses a compact scannable answer QR for a realistic multi-question set without changing coordinates', () => {
  const questions = [
    ...set.questions,
    {id:'3333333333333333', type:'bearing', prompt:'A 至 B 的前視方位？', reference:'', points:[{lat:22.383496510353,lon:114.32246405324},{lat:22.39,lon:114.33}],answer:'方格北前視 045°，後視 225°'},
  ];
  const sample = {...set,questions};
  const url = answerShare(sample, null, 'https://hm20c.vercel.app/');
  expect(QRCode.create(url, {errorCorrectionLevel:'M'}).version).toBeLessThanOrEqual(17);
  expect(decodeShared(url).set.questions[2].points).toEqual(questions[2].points);
  expect(() => decodeShared('#answers=Z0123Z')).toThrow();
});
