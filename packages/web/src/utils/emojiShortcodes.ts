import emojiData from '@emoji-mart/data';
import type { EmojiMartData } from '@emoji-mart/data';
import { DISCORD_EMOJI_ALIASES } from './discordEmojiAliases';

const data = emojiData as EmojiMartData;
let emojiByName: Map<string, string> | undefined;

function getEmojiByName(): Map<string, string> {
  if (emojiByName) return emojiByName;
  const names = new Map<string, string>();
  for (const [id, emoji] of Object.entries(data.emojis)) {
    const native = emoji.skins[0]?.native;
    if (native) names.set(id.replace(/-/g, '_'), native);
  }
  for (const [alias, id] of Object.entries(data.aliases)) {
    const native = data.emojis[id]?.skins[0]?.native;
    if (native) names.set(alias.replace(/-/g, '_'), native);
  }
  emojiByName = names;
  return names;
}

/** Convert known :emoji: aliases for display only; stored message text is untouched. */
export function renderEmojiShortcodes(text: string): string {
  if (!text.includes(':')) return text;
  const names = getEmojiByName();
  return text.replace(/:([a-z0-9_+-]+):/g, (match, name: string, offset: number, source: string) => {
    const beforeChar = source[offset - 1];
    const afterChar = source[offset + match.length];
    if ((beforeChar && /^[A-Za-z0-9]$/.test(beforeChar)) || (afterChar && /^[A-Za-z0-9]$/.test(afterChar))) return match;
    const before = source.slice(0, offset);
    if (/\b(?:https?|ftp):\/\/\S*$/i.test(before) || /\bwww\.\S*$/i.test(before)) return match;
    const normalized = name.replace(/-/g, '_');
    const emoji = names.get(normalized) ?? DISCORD_EMOJI_ALIASES[normalized];
    return emoji ?? match;
  });
}

interface MdastTextNode {
  type: string;
  value?: string;
  children?: MdastTextNode[];
}

export function remarkEmojiShortcodes() {
  return (tree: MdastTextNode) => {
    const visit = (node: MdastTextNode) => {
      if (node.type === 'text' && typeof node.value === 'string') {
        node.value = renderEmojiShortcodes(node.value);
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
