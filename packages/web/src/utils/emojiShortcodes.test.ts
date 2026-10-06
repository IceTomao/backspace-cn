import { describe, expect, it } from 'vitest';
import { renderEmojiShortcodes } from './emojiShortcodes';

describe('renderEmojiShortcodes', () => {
  it('renders known aliases without changing unknown text', () => {
    expect(renderEmojiShortcodes('hi :smile: :not_a_real_emoji:')).toBe('hi 😄 :not_a_real_emoji:');
  });

  it('supports Discord-only shortcode names', () => {
    expect(renderEmojiShortcodes(':zipper_mouth:')).toBe('🤐');
  });

  it('preserves code-like identifiers and URL text', () => {
    expect(renderEmojiShortcodes('user:id:42 https://example.test/:smile:')).toBe('user:id:42 https://example.test/:smile:');
  });

  it('supports emoji aliases adjacent to CJK and repeated aliases', () => {
    expect(renderEmojiShortcodes('你好:heart::heart:')).toBe('你好❤️❤️');
  });
});
