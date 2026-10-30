import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { BOOKMARKS_KEY, loadBookmarks, makeBookmark, MAX_BOOKMARKS, saveBookmarks } from '../src/lib/bookmarks';

describe('manual map-centre bookmarks', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('stores only a named coordinate in this browser, with sensible precision', () => {
    const bookmark = makeBookmark({ lat: 22.383512345, lon: 114.322598765, scaleWidth: 95 }, '  集合處  ');
    expect(bookmark).toMatchObject({ name: '集合處', lat: 22.3835123, lon: 114.3225988 });
    expect(bookmark).not.toHaveProperty('scaleWidth');
    expect(saveBookmarks([bookmark])).toBe(true);
    expect(loadBookmarks()).toEqual([bookmark]);
    expect(makeBookmark({ lat: 22.4, lon: 114.1 }, ' ')).toBeNull();
    expect(makeBookmark({ lat: NaN, lon: 114.1 }, '無效')).toBeNull();
    expect(makeBookmark({ lat: 86, lon: 114.1 }, '無效')).toBeNull();
    expect(makeBookmark({ lat: 22.4, lon: 181 }, '無效')).toBeNull();
  });

  it('ignores corrupt, unsafe and duplicate entries while retaining valid ones', () => {
    const valid = { id: 'valid', name: '西貢', lat: 22.38, lon: 114.32 };
    localStorage.setItem(BOOKMARKS_KEY, '{bad');
    expect(loadBookmarks()).toEqual([]);
    localStorage.setItem(BOOKMARKS_KEY, JSON.stringify([valid, valid, null, { ...valid, id: 'unsafe', lat: 100 }, { ...valid, id: 'empty', name: ' ' }]));
    expect(loadBookmarks()).toEqual([valid]);
    expect(saveBookmarks([valid, valid])).toBe(false);
    expect(saveBookmarks(Array.from({ length: MAX_BOOKMARKS + 1 }, (_, index) => ({ ...valid, id: String(index) })))).toBe(false);
  });

  it('reports quota or storage errors without changing existing entries', () => {
    const previous = makeBookmark({ lat: 22.4, lon: 114.1 }, '已保存');
    expect(saveBookmarks([previous])).toBe(true);
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    const next = makeBookmark({ lat: 22.38, lon: 114.3 }, '新地點');
    expect(saveBookmarks([next, previous])).toBe(false);
    expect(loadBookmarks()).toEqual([previous]);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
