import { useSyncExternalStore } from 'react';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '../contexts/dataOwnerGeneration';

/**
 * Window-level shared projection for plugin display reads (UI prompts, picker models,
 * pre-run candidates). Execution authorization must not consume this cache.
 */
export interface GhostDisplayProjection<T> {
  getSnapshot(): T;
  getEmptySnapshot(): T;
  subscribe(listener: () => void): () => void;
  invalidate(): void;
  __resetForTest(): void;
}

export function createGhostDisplayProjection<T>(read: () => Promise<T>, empty: T): GhostDisplayProjection<T> {
  let owner = getDataOwnerGeneration();
  let snapshot = empty;
  let loaded = false;
  let loading = false;
  let dirty = false;
  let request = 0;
  let subscribed = false;
  let unsubscribe: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const current = () => isDataOwnerGenerationCurrent(owner);
  const notify = () => { for (const listener of listeners) listener(); };

  const refresh = async () => {
    if (!current()) return;
    if (loading) { dirty = true; return; }
    loading = true;
    dirty = false;
    const revision = ++request;
    try {
      const value = await read();
      if (!current() || revision !== request) return;
      snapshot = value;
      loaded = true;
      notify();
    } catch {
      // Keep the last good display projection; the next notification/subscription can retry.
    } finally {
      loading = false;
      if (dirty && current() && listeners.size) void refresh();
    }
  };

  const ensure = () => {
    if (!current()) {
      owner = getDataOwnerGeneration();
      snapshot = empty;
      loaded = false;
      request += 1;
      // 切 owner 时旧请求可能仍在途；旧回包会被 revision 丢弃。
      // 必须留下一次新 owner 的读取，否则没有插件通知时投影会停在空快照。
      dirty = true;
    }
    if (!subscribed) {
      subscribed = true;
      unsubscribe = window.electronAPI.ghosts.onChanged(() => {
        if (!current()) return;
        if (listeners.size) void refresh();
        else dirty = true;
      });
    }
    if (!loaded && !loading) void refresh();
    else if (dirty && listeners.size) void refresh();
  };

  return {
    getSnapshot() { ensure(); return snapshot; },
    getEmptySnapshot() { return empty; },
    subscribe(listener) {
      ensure();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) dirty = true;
      };
    },
    invalidate() {
      request += 1;
      loaded = false;
      if (listeners.size) void refresh();
      else dirty = true;
    },
    __resetForTest() {
      unsubscribe?.();
      unsubscribe = undefined;
      subscribed = false;
      listeners.clear();
      owner = getDataOwnerGeneration();
      snapshot = empty;
      loaded = false;
      loading = false;
      dirty = false;
      request = 0;
    },
  };
}

const noSubscription = () => () => {};

export function useGhostDisplayProjection<T>(projection: GhostDisplayProjection<T>, enabled = true): T {
  const empty = projection.getEmptySnapshot();
  return useSyncExternalStore(
    enabled ? projection.subscribe : noSubscription,
    enabled ? projection.getSnapshot : () => empty,
  );
}
