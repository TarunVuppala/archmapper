const listeners: Record<string, Array<(payload: unknown) => void>> = {};

export function emit(event: string, payload: unknown) {
  for (const fn of listeners[event] ?? []) fn(payload);
}

export function subscribe(event: string, fn: (payload: unknown) => void) {
  listeners[event] = listeners[event] ?? [];
  listeners[event].push(fn);
}
