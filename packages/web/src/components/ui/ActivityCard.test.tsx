import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Activity } from '@backspace/shared';
import { setLanguage } from '../../i18n';
import { ActivityCard } from './ActivityCard';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-04T12:00:00Z'));
});

afterEach(async () => {
  await setLanguage('en');
  vi.useRealTimers();
});

describe('ActivityCard', () => {
  it('localizes the elapsed activity time', async () => {
    await setLanguage('ru');
    const activity: Activity = {
      type: 'playing',
      name: 'Escape from Tarkov',
      timestamps: { start: Date.now() - 32 * 60 * 1000 },
    };

    render(<ActivityCard activities={[activity]} />);

    expect(screen.getByText('Escape from Tarkov')).toBeInTheDocument();
    expect(screen.getByText('Прошло 32 мин.')).toBeInTheDocument();
  });

  it('renders game details with music as a secondary activity', () => {
    const game: Activity = {
      type: 'playing', name: 'League of Legends', details: '使用：亚索', state: '排位单人/双人 · 游戏中', timestamps: { start: Date.now() - 60_000 },
    };
    const music: Activity = { type: 'listening', name: 'Spotify', details: 'Blinding Lights', state: 'The Weeknd · After Hours' };

    render(<ActivityCard activities={[game, music]} />);

    expect(screen.getByText('使用：亚索')).toBeInTheDocument();
    expect(screen.getByText('排位单人/双人 · 游戏中')).toBeInTheDocument();
    expect(screen.getByText('Spotify · Blinding Lights · The Weeknd · After Hours')).toBeInTheDocument();
  });
});
