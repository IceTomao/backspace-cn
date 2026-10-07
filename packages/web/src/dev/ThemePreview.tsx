import { useState, type FormEvent } from 'react';
import {
  Bell, Bookmark, ChevronDown, Compass, Download, Hash, Headphones, Image,
  MessageCircle, MoreHorizontal, Plus, Search, Send, Settings, Smile, Users,
} from 'lucide-react';
import { Avatar } from '../components/ui/Avatar';

type PreviewMessage = { author: string; time: string; text: string; color: string; avatar: string };

const initialMessages: PreviewMessage[] = [
  { author: 'yycc', time: '昨天 15:07', text: '没这么晚', color: '#8f6be8', avatar: 'Y' },
  { author: '聊天尊', time: '昨天 18:27', text: '好痕啊', color: '#df7c88', avatar: '聊' },
  { author: '745909697', time: '昨天 19:38', text: '几点', color: '#d99412', avatar: '7' },
  { author: '咲希队长', time: '昨天 19:39', text: '看略怕的吧', color: '#3d8b72', avatar: '咲' },
  { author: '聊天尊', time: '昨天 20:58', text: '要起嘛', color: '#df7c88', avatar: '聊' },
  { author: '咲希队长', time: '昨天 21:04', text: '来了', color: '#3d8b72', avatar: '咲' },
];

export function ThemePreview() {
  const [messages, setMessages] = useState(initialMessages);
  const [draft, setDraft] = useState('');
  const [activeChannel, setActiveChannel] = useState('大厅');
  const [scheme, setScheme] = useState<'light' | 'dark'>('light');

  function changeScheme(value: 'light' | 'dark') {
    setScheme(value);
    document.documentElement.dataset.colorScheme = value;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', value === 'light' ? '#eff3f8' : '#0b0b10');
  }

  function sendMessage(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setMessages(current => [...current, { author: '你', time: '现在', text, color: '#8f6be8', avatar: '你' }]);
    setDraft('');
  }

  return <main className="flex h-screen min-h-0 overflow-hidden bg-surface-base text-txt-primary">
    <nav aria-label="服务器" className="hidden w-[72px] shrink-0 flex-col items-center gap-3 border-r border-border-soft bg-surface-base py-4 md:flex">
      <div className="mb-2 grid h-10 w-10 place-items-center rounded-xl bg-accent-primary font-bold text-white shadow-sm">B</div>
      <button aria-label="Aurora" className="grid h-11 w-11 place-items-center rounded-xl bg-accent-primary text-white shadow-sm">A</button>
      <button aria-label="添加服务器" className="grid h-10 w-10 place-items-center rounded-xl text-status-online hover:bg-interactive-hover"><Plus size={20} /></button>
      <div className="my-1 h-px w-8 bg-border-soft" />
      <button aria-label="探索" className="grid h-10 w-10 place-items-center rounded-xl text-txt-secondary hover:bg-interactive-hover"><Compass size={19} /></button>
    </nav>

    <aside className="hidden w-[248px] shrink-0 flex-col border-r border-border-hard bg-surface-channel md:flex">
      <button className="flex h-14 items-center justify-between border-b border-border-hard px-4 text-left font-semibold">
        Aurora <ChevronDown size={16} className="text-txt-tertiary" />
      </button>
      <div className="flex-1 overflow-y-auto px-2 py-4">
        <div className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wide text-txt-tertiary">文字频道</div>
        {['大厅', '开车', '游戏截图'].map(channel => <button key={channel} onClick={() => setActiveChannel(channel)}
          className={`relative mb-1 flex h-9 w-full items-center gap-2 rounded-md px-2 text-sm transition-colors ${activeChannel === channel ? 'bg-interactive-selected text-txt-primary font-medium' : 'text-txt-secondary hover:bg-interactive-hover'}`}>
          {activeChannel === channel && <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r bg-accent-primary" />}
          <Hash size={17} className={activeChannel === channel ? 'text-accent-primary' : 'text-txt-tertiary'} /> {channel}
        </button>)}
        <div className="mb-2 mt-6 px-2 text-[11px] font-semibold uppercase tracking-wide text-txt-tertiary">语音频道</div>
        {['101涅槃组', '101翻山组'].map(channel => <button key={channel} className="mb-1 flex h-9 w-full items-center gap-2 rounded-md px-2 text-sm text-txt-secondary hover:bg-interactive-hover"><Headphones size={16} />{channel}</button>)}
        <div className="mb-2 mt-6 px-2 text-[11px] font-semibold uppercase tracking-wide text-txt-tertiary">私信</div>
        <button className="flex h-10 w-full items-center gap-2 rounded-md bg-interactive-selected px-2 text-left text-sm text-txt-primary"><Avatar name="咲希队长" size={25} status="online" /><span>咲希队长</span><span className="ml-auto h-2 w-2 rounded-full bg-accent-rose" /></button>
      </div>
      <div className="flex h-[68px] items-center gap-2 border-t border-border-hard bg-surface-elevated/60 px-3">
        <Avatar name="咲希队长" size={34} status="online" />
        <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">咲希队长</div><div className="text-xs text-txt-tertiary">@xiaoxicaptain</div></div>
        <button aria-label="设置" className="rounded p-2 text-txt-secondary hover:bg-interactive-hover"><Settings size={17} /></button>
      </div>
    </aside>

    <section className="relative flex min-w-0 flex-1 flex-col bg-surface-chat">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border-soft bg-surface-elevated/70 px-4">
        <div className="flex min-w-0 items-center gap-2 font-semibold"><Hash size={18} className="text-accent-primary" />{activeChannel}</div>
        <div className="flex items-center gap-1 text-txt-secondary">
          <div className="mr-1 flex rounded-md border border-border-soft bg-surface-channel p-1" role="group" aria-label="预览主题">
            <button onClick={() => changeScheme('light')} aria-pressed={scheme === 'light'} className={`rounded px-1.5 py-1 text-xs ${scheme === 'light' ? 'bg-surface-elevated text-txt-primary shadow-sm' : 'hover:bg-interactive-hover'}`}>浅色</button>
            <button onClick={() => changeScheme('dark')} aria-pressed={scheme === 'dark'} className={`rounded px-1.5 py-1 text-xs ${scheme === 'dark' ? 'bg-surface-elevated text-txt-primary shadow-sm' : 'hover:bg-interactive-hover'}`}>深色</button>
          </div>
          <button aria-label="通知" className="rounded-md p-2 hover:bg-interactive-hover"><Bell size={18} /></button>
          <button aria-label="搜索" className="rounded-md p-2 hover:bg-interactive-hover"><Search size={18} /></button>
          <button aria-label="成员" className="rounded-md p-2 hover:bg-interactive-hover lg:hidden"><Users size={18} /></button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6">
        <div className="mx-auto flex max-w-4xl flex-col gap-2">
          {messages.map((message, index) => <article key={`${message.author}-${index}`} className="group relative flex gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-[var(--interactive-message-hover)]">
            <Avatar name={message.author} size={36} status={index === 1 ? 'online' : undefined} avatarColor={message.color} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2"><span className="font-semibold" style={{ color: message.author === '聊天尊' ? 'rgb(var(--text-username-owner))' : undefined }}>{message.author}</span><time className="text-[11px] text-txt-tertiary">{message.time}</time></div>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-txt-message">{message.text}</p>
              {index === 4 && <div className="mt-2 flex h-[72px] max-w-[320px] items-center gap-3 rounded-md border border-border-soft bg-surface-elevated px-3 shadow-sm"><div className="grid h-12 w-12 place-items-center rounded bg-accent-primary/10 text-accent-primary"><Image size={22} /></div><div className="min-w-0"><div className="truncate text-sm font-medium text-txt-primary">游戏截图.png</div><div className="text-xs text-txt-tertiary">PNG 图片 · 1.8 MB</div></div><Download size={16} className="ml-auto shrink-0 text-txt-tertiary" /></div>}
            </div>
            {index === 1 && <div className="absolute right-3 top-0 hidden items-center gap-1 rounded-lg border border-border-soft bg-surface-elevated px-2 py-1 text-txt-secondary shadow-md sm:flex"><button aria-label="表情回应" className="rounded p-1 hover:bg-interactive-hover">👍</button><button aria-label="更多消息操作" className="rounded p-1 hover:bg-interactive-hover"><MoreHorizontal size={16} /></button></div>}
          </article>)}
        </div>
      </div>
      <form onSubmit={sendMessage} className="relative shrink-0 px-3 pb-3 sm:px-4 sm:pb-4">
        <div className="pointer-events-none absolute bottom-[calc(100%-4px)] left-4 right-4 mx-auto hidden max-w-4xl sm:block">
          <div className="pointer-events-auto mb-2 max-w-[380px] rounded-xl border border-border-soft bg-surface-elevated p-3 shadow-elevation-high">
            <div className="mb-2 flex items-center gap-2 border-b border-border-soft pb-2 text-xs"><span className="rounded bg-interactive-selected px-2 py-1 font-medium text-accent-primary">收藏</span><span className="px-2 py-1 text-txt-tertiary">Emoji</span><span className="ml-auto text-txt-tertiary">常用表情</span></div>
            <div className="flex gap-2 text-[26px]"><button type="button" aria-label="猫咪表情" className="grid h-11 w-11 place-items-center rounded-md bg-surface-channel hover:bg-interactive-hover">😺</button><button type="button" aria-label="笑脸表情" className="grid h-11 w-11 place-items-center rounded-md bg-surface-channel hover:bg-interactive-hover">😂</button><button type="button" aria-label="爱心表情" className="grid h-11 w-11 place-items-center rounded-md bg-surface-channel hover:bg-interactive-hover">💛</button><button type="button" aria-label="更多表情" className="grid h-11 w-11 place-items-center rounded-md border border-dashed border-border-hard text-txt-tertiary"><Plus size={18} /></button></div>
          </div>
        </div>
        <div className="mx-auto flex max-w-4xl items-end gap-2 rounded-xl border border-border-soft bg-surface-elevated px-3 py-2 shadow-input focus-within:border-accent-primary/50 focus-within:ring-2 focus-within:ring-accent-primary/10">
          <button type="button" aria-label="添加附件" className="mb-0.5 rounded p-1 text-txt-tertiary hover:bg-interactive-hover"><Plus size={19} /></button>
          <textarea aria-label="发送消息" rows={1} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={`发送消息到 #${activeChannel}`} className="max-h-28 min-h-7 flex-1 resize-none bg-transparent py-1 text-sm text-txt-primary placeholder:text-txt-tertiary focus:outline-none" />
          <button type="button" aria-label="表情" className="mb-0.5 rounded p-1 text-txt-secondary hover:bg-interactive-hover"><Smile size={19} /></button>
          <button aria-label="发送" disabled={!draft.trim()} className="mb-0.5 rounded p-1 text-accent-primary disabled:opacity-40"><Send size={18} /></button>
        </div>
      </form>
      <nav aria-label="移动导航" className="flex h-14 shrink-0 items-center justify-around border-t border-border-soft bg-surface-elevated pb-[var(--safe-bottom)] text-txt-tertiary md:hidden">
        <button className="flex flex-col items-center gap-0.5 text-accent-primary"><Compass size={19} /><span className="text-[10px]">空间</span></button><button className="flex flex-col items-center gap-0.5"><MessageCircle size={19} /><span className="text-[10px]">私信</span></button><button className="flex flex-col items-center gap-0.5"><Users size={19} /><span className="text-[10px]">成员</span></button>
      </nav>
    </section>

    <aside aria-label="成员" className="hidden w-[232px] shrink-0 border-l border-border-soft bg-surface-members px-3 py-4 lg:block">
      <div className="mb-4 text-[11px] font-semibold uppercase tracking-wide text-txt-tertiary">在线 — 2</div>
      {['聊天尊', '咲希队长'].map((name, index) => <button key={name} className="mb-1 flex w-full items-center gap-2.5 rounded-md px-1.5 py-2 text-left transition-colors hover:bg-interactive-hover">
        <Avatar name={name} size={32} status="online" avatarColor={index ? '#3d8b72' : '#df7c88'} /><span className="truncate text-sm text-txt-primary">{name}</span>
      </button>)}
      <div className="mb-4 mt-7 text-[11px] font-semibold uppercase tracking-wide text-txt-tertiary">离线 — 2</div>
      {['745909697', 'yycc'].map((name, index) => <button key={name} className="mb-1 flex w-full items-center gap-2.5 rounded-md px-1.5 py-2 text-left opacity-65 hover:bg-interactive-hover">
        <Avatar name={name} size={32} avatarColor={index ? '#8f6be8' : '#d99412'} /><span className="truncate text-sm text-txt-secondary">{name}</span>
      </button>)}
      <div className="mt-6 border-t border-border-soft pt-4 text-xs font-medium text-txt-secondary">表面层级</div>
      <div className="mt-2 rounded-lg border border-border-soft bg-surface-elevated p-3 text-xs text-txt-secondary shadow-sm">浮层与卡片使用白色表面</div>
      <div className="mt-2 flex items-center gap-2 rounded-md bg-interactive-selected px-3 py-2 text-xs text-txt-primary"><Bookmark size={15} className="text-accent-primary" />选中与收藏状态</div>
      <button className="mt-2 flex w-full items-center gap-2 rounded-md bg-surface-input px-3 py-2 text-xs text-txt-secondary hover:bg-interactive-hover"><Download size={15} />悬停状态</button>
    </aside>
  </main>;
}
