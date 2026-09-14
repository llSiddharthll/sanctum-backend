import { describe, it, expect } from 'vitest';
import { toPostType } from '../src/services/sheet-publish';

/**
 * Calendar sheets spell the Format cell many ways. An exact-key lookup used to
 * publish "Reels" / "IG Reel" / "Video" as plain posts, so reels lost their tag,
 * their 9:16 preview and their place in the client's Reels grid.
 */
describe('sheet Format cell → post type', () => {
  it.each([
    ['reel', 'reel'],
    ['reels', 'reel'],
    ['ig reel', 'reel'],
    ['instagram reel', 'reel'],
    ['video', 'reel'],
    ['yt shorts', 'reel'],
    ['story', 'story'],
    ['stories', 'story'],
    ['carousel', 'carousel'],
    ['carousel post', 'carousel'],
    ['static', 'post'],
    ['post', 'post'],
    ['', 'post'],
    ['something else', 'post'],
  ])('%j → %s', (raw, want) => {
    expect(toPostType(raw)).toBe(want);
  });
});
