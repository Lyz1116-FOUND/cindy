/**
 * ghostWorkdirFilter — 意识清单的「工作目录级禁用」过滤(renderer 侧)。
 *
 * main 侧生效点(花名册 / ghost_list / ghost_info / ghost_call)已按会话 workdir 过滤;
 * 这里补齐 renderer 的两个入口,让被禁用的意识在该目录下彻底"不存在":
 *   - `$` 指令确认胶囊(GhostCommandDecoration 的 roster);
 *   - 发送期展开(expandGhostCommand 的 ghosts 入参,含编辑重发)。
 * 两处必须与 main 同判,否则会出现"胶囊亮了 / 指令展开了,调用却被
 * GHOST_DISABLED_IN_WORKDIR 拒绝"的裂缝。
 *
 * 展示用清单异步读取，避免 main 忙于其它工作时阻塞输入框渲染。
 * 发送时仍现查策略；目录键归一化在 main 侧统一做。
 */

import { useSyncExternalStore } from 'react';
import type { InstalledGhost } from '../../shared/ghost';
import { installedGhostStoragePart } from '../../shared/pluginIdentity';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, isDataOwnerPushCurrent } from '../contexts/dataOwnerGeneration';

/** 该 workdir 下被禁用的 ghostId 集合;无 workdir / 查询异常 = 空集。 */
export function getWorkdirDisabledGhostIds(workdir: string | null | undefined): Set<string> {
  if (!workdir || workdir.trim().length === 0) return new Set();
  try {
    return new Set(window.electronAPI.ghosts.workdirPrefsSync(workdir).disabled);
  } catch {
    // jsdom 单测 / preload 未就绪:安全退化为"无禁用"(与旧行为一致)。
    return new Set();
  }
}

/**
 * 按 workdir 过滤意识清单。无禁用时返回**原引用**——
 * setGhostCommandRoster 按引用去重,别让空过滤打散它。
 */
export function filterGhostsForWorkdir(
  ghosts: InstalledGhost[],
  workdir: string | null | undefined,
): InstalledGhost[] {
  if (ghosts.length === 0) return ghosts;
  const disabled = getWorkdirDisabledGhostIds(workdir);
  if (disabled.size === 0) return ghosts;
  const filtered = ghosts.filter((g) => !disabled.has(installedGhostStoragePart(g)));
  return filtered.length === ghosts.length ? ghosts : filtered;
}

const NO_DISABLED_GHOSTS = new Set<string>();
type WorkdirPolicySnapshot = { workdir: string; disabled: Set<string> } | null;
const policyStores = new Map<string, ReturnType<typeof createPolicyStore>>();

/** Display-only shared policy read. Sending still checks current policy at the host. */
function createPolicyStore(workdir: string) {
  const owner = getDataOwnerGeneration();
  const listeners = new Set<() => void>();
  let snapshot: WorkdirPolicySnapshot = null;
  let workdirKey: string | undefined;
  let revision = 0;
  let disposed = false;
  const current = () => !disposed && isDataOwnerGenerationCurrent(owner);
  const notify = () => { for (const listener of listeners) listener(); };
  const refresh = () => {
    if (!current()) return;
    const requested = ++revision;
    void Promise.resolve().then(() => window.electronAPI.ghosts.workdirPrefs(workdir)).then((policy) => {
      if (!current() || requested !== revision) return;
      workdirKey = policy.workdirKey;
      snapshot = { workdir, disabled: new Set(policy.disabled) };
      notify();
    }).catch(() => {
      if (current() && requested === revision) { snapshot = null; notify(); }
    });
  };
  const unsubscribe = window.electronAPI.ghosts.onWorkdirPrefsChanged?.((policy, ownerStamp) => {
    if (!current() || !isDataOwnerPushCurrent(ownerStamp)) return;
    if (workdirKey === undefined) { refresh(); return; }
    if (workdirKey !== policy.workdirKey) return;
    revision++;
    snapshot = { workdir, disabled: new Set(policy.disabled) };
    notify();
  });
  refresh();
  return {
    current,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          disposed = true;
          unsubscribe?.();
          policyStores.delete(workdir);
        }
      };
    },
  };
}

function getPolicyStore(workdir: string) {
  let store = policyStores.get(workdir);
  if (store && !store.current()) { policyStores.delete(workdir); store = undefined; }
  if (!store) { store = createPolicyStore(workdir); policyStores.set(workdir, store); }
  return store;
}

const noSubscription = () => () => {};
const nullSnapshot = () => null;

/** Display-only projection. Sending still checks current policy at the host. */
export function useWorkdirDisabledGhostIds(
  workdir: string | null | undefined,
  ghosts: InstalledGhost[],
  enabled = true,
): Set<string> | null {
  const active = enabled && !!workdir?.trim() && ghosts.length > 0;
  const store = active && workdir ? getPolicyStore(workdir) : null;
  const snapshot = useSyncExternalStore(store ? store.subscribe : noSubscription, store ? store.getSnapshot : nullSnapshot);
  if (!active) return NO_DISABLED_GHOSTS;
  return snapshot && snapshot.workdir === workdir ? snapshot.disabled : null;
}
