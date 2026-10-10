import type { VoiceServiceState } from '@backspace/shared';

type Listener = (origin: string, state: VoiceServiceState | null | undefined) => void;
const listeners = new Set<Listener>();

export function notifyVoiceRecovery(origin: string, state?: VoiceServiceState | null): void {
  for (const listener of listeners) listener(origin, state);
}

export function onVoiceRecovery(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
