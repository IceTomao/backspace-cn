export interface MessageJumpDependencies {
  tryScroll: () => boolean;
  loadAround: () => Promise<void>;
  afterRender?: () => Promise<void>;
}

function afterTwoAnimationFrames(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/** Load the target window only when the message is not already rendered. */
export async function ensureMessageJumpTarget({
  tryScroll,
  loadAround,
  afterRender = afterTwoAnimationFrames,
}: MessageJumpDependencies): Promise<boolean> {
  if (tryScroll()) return true;
  await loadAround();
  await afterRender();
  return tryScroll();
}
