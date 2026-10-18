export const MEAL_PHOTO_REQUEST_TIMEOUT_MS = 80_000;

/** Bound the complete operation, including auth and reading the response body.
 * Some stalled transports do not settle when their fetch signal is aborted. */
export async function withMealPhotoDeadline<T>(run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  let rejectStopped: (reason: Error) => void = () => {};
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
  const cancel = () => {
    const error = new DOMException('Meal photo estimation was cancelled.', 'AbortError');
    rejectStopped(error);
    controller.abort(error);
  };
  const timer = setTimeout(() => {
    const error = new Error('Meal photo estimation took too long. Your photo is still selected. Try again, or enter the amounts below.');
    rejectStopped(error);
    controller.abort(new DOMException('Meal photo estimation timed out.', 'TimeoutError'));
  }, MEAL_PHOTO_REQUEST_TIMEOUT_MS);
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return run(controller.signal);
    }), stopped]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
