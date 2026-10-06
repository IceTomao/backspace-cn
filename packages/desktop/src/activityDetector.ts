import type { ActivityProvider, DesktopActivity } from './activityTypes';
import type { ActivityAssetPublisher } from './activityAssetPublisher';
import { LeagueProvider } from './leagueProvider';
import { ProcessGameProvider } from './processGameProvider';
import { WindowsMediaProvider } from './windowsMediaProvider';

let providers: ActivityProvider[] = [];
let currentActivities: DesktopActivity[] = [];
let callback: ((activities: DesktopActivity[]) => void) | null = null;

function emit(): void {
  const detected = providers.flatMap((provider) => provider.getActivities());
  const next = detected.slice(0, 5).map(({ source: _source, ...activity }) => activity);
  if (JSON.stringify(next) === JSON.stringify(currentActivities)) return;
  currentActivities = next;
  callback?.(next);
}

export function startActivityDetection(
  onActivitiesChange: (activities: DesktopActivity[]) => void,
  assetPublisher?: ActivityAssetPublisher,
): void {
  if (providers.length) return;
  callback = onActivitiesChange;
  providers = [new LeagueProvider(), new ProcessGameProvider(assetPublisher), new WindowsMediaProvider(assetPublisher)];
  for (const provider of providers) provider.start(emit);
  emit();
}

export function stopActivityDetection(): void {
  for (const provider of providers) provider.stop();
  providers = [];
  callback = null;
  currentActivities = [];
}

export function getCurrentActivities(): DesktopActivity[] { return currentActivities; }
