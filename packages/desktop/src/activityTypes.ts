export interface ActivityTimestamps {
  start?: number;
  end?: number;
}

export interface ActivityAssets {
  largeImage?: string;
  largeText?: string;
  smallImage?: string;
  smallText?: string;
}

export interface DesktopActivity {
  type: 'playing' | 'listening' | 'watching' | 'streaming';
  name: string;
  details?: string;
  state?: string;
  timestamps?: ActivityTimestamps;
  assets?: ActivityAssets;
  url?: string;
}

export interface DetectedActivity extends DesktopActivity {
  /** Local-only classification. Never forwarded to the server. */
  source: 'game' | 'music';
}

export interface ActivityProvider {
  start(onChange: () => void): void;
  stop(): void;
  getActivities(): DetectedActivity[];
}
