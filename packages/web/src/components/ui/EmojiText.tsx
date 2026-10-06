import { renderEmojiShortcodes } from '../../utils/emojiShortcodes';

export function EmojiText({ children }: { children: string }) {
  return <>{renderEmojiShortcodes(children)}</>;
}
