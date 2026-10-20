export interface NativeWorkReadinessInput {
  state: 'preparing' | 'starting' | 'ready';
  message: string | null;
}
/** Missing status preserves compatibility with workers that predate native preparation. */
export function nativeWorkReadiness(value?: NativeWorkReadinessInput | null) {
  if (!value || value.state === 'ready') return null;
  return {
    state: value.state,
    title: value.state === 'preparing' ? 'Preparing native work' : 'Synchronizing repositories',
    message: value.message?.trim() || (value.state === 'preparing'
      ? 'Preparing the command runtime. Saved requests remain queued; native work will start automatically.'
      : 'Synchronizing assigned repositories. Saved requests remain queued; native work will start automatically.'),
  };
}
