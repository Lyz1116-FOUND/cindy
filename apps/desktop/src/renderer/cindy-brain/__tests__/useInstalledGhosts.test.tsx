// @vitest-environment jsdom
/**
 * useInstalledGhosts.test.tsx — 已装意识清单的窗口级共享缓存契约。
 *
 * 背景(2026-07 卡顿修复):hook 旧版每个组件实例挂载各自 listSync(sendSync
 * 阻塞 renderer + main 全量扫盘),AgentActionRow 等聊天行无条件消费,大会话
 * 一帧上百行 = 上百次同步扫描。本文件锁死新契约:
 * 1. 任意多个消费者,整个窗口 listSync 只发生一次;
 * 2. 所有消费者读到同一引用(getSnapshot 引用稳定);
 * 3. ghosts:changed 推送后全体刷新,仍不重扫(payload 自带全量清单)。
 */
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost';
import { useWorkdirDisabledGhostIds } from '../ghostWorkdirFilter';
import { createGhostDisplayProjection, useGhostDisplayProjection } from '../ghostDisplayProjection';
import { setDataOwnerGeneration, __testing as dataOwnerTesting } from '../../contexts/dataOwnerGeneration';
import {
  __resetInstalledGhostsStoreForTest,
  useInstalledGhosts,
} from '../useInstalledGhosts';

const ghost = (id: string, name = id): InstalledGhost => ({
  manifest: {
    schemaVersion: 2,
    id,
    name,
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
  },
  dir: `/brain/${id}`,
  enabled: true,
  approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
});

type ChangedCb = (payload: { ghosts: InstalledGhost[] }) => void;

const listSync = vi.fn<() => { ghosts: InstalledGhost[] }>();
const changedCbs: ChangedCb[] = [];
const unsubscribeChanged = vi.fn();
const onChanged = vi.fn((cb: ChangedCb) => {
  changedCbs.push(cb);
  return unsubscribeChanged;
});

beforeEach(() => {
  dataOwnerTesting.reset();
  __resetInstalledGhostsStoreForTest();
  listSync.mockReset();
  listSync.mockReturnValue({ ghosts: [ghost('cindy-art')] });
  changedCbs.length = 0;
  unsubscribeChanged.mockReset();
  onChanged.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    ghosts: {
      listSync,
      onChanged,
    },
  };
});

afterEach(() => {
  cleanup();
  dataOwnerTesting.reset();
  __resetInstalledGhostsStoreForTest();
});

// KFJS unit regression: old-directory responses must not expose commands in a
// newly selected directory; this asynchronous display path must not sendSync.
it('loads directory policy asynchronously and discards stale directory responses', async () => {
  const pending = new Map<string, (value: { disabled: string[] }) => void>();
  const workdirPrefs = vi.fn((dir: string) => new Promise<{ disabled: string[] }>((resolve) => pending.set(dir, resolve)));
  const workdirPrefsSync = vi.fn(() => { throw new Error('blocking IPC'); });
  Object.assign(window.electronAPI.ghosts, { workdirPrefs, workdirPrefsSync });
  const ghosts = [ghost('a')];
  const { result, rerender } = renderHook(({ dir }) => useWorkdirDisabledGhostIds(dir, ghosts), { initialProps: { dir: 'first' } });
  expect(result.current).toBeNull();
  await act(async () => {});
  rerender({ dir: 'second' });
  await act(async () => {});
  await act(async () => { pending.get('second')!({ disabled: ['a'] }); });
  expect([...result.current!]).toEqual(['a']);
  await act(async () => { pending.get('first')!({ disabled: [] }); });
  expect([...result.current!]).toEqual(['a']);
  expect(workdirPrefsSync).not.toHaveBeenCalled();
});

// Unit regression: scoped policy pushes replace global roster refreshes. They
// must update matching aliases, ignore other projects, and win over stale reads.
it('updates only the matching canonical directory without reloading the roster or policy', async () => {
  let changed!: (policy: { workdirKey: string; disabled: string[] }, stamp?: unknown) => void;
  const unsubscribe = vi.fn();
  const workdirPrefs = vi.fn(async () => ({ workdirKey: 'c:\\project', disabled: [] as string[] }));
  Object.assign(window.electronAPI.ghosts, {
    workdirPrefs,
    onWorkdirPrefsChanged: (callback: typeof changed) => { changed = callback; return unsubscribe; },
  });
  const ghosts = [ghost('a')];
  const { result, unmount } = renderHook(() => useWorkdirDisabledGhostIds('C:/Project/', ghosts));
  await act(async () => {});
  act(() => changed({ workdirKey: 'c:\\project', disabled: ['a'] }, { dataOwnerId: 'old-owner', ownerGeneration: 0 }));
  expect([...result.current!]).toEqual([]);
  act(() => changed({ workdirKey: '/other', disabled: ['a'] }));
  expect([...result.current!]).toEqual([]);
  act(() => changed({ workdirKey: 'c:\\project', disabled: ['a'] }));
  expect([...result.current!]).toEqual(['a']);
  expect(workdirPrefs).toHaveBeenCalledOnce();
  expect(listSync).not.toHaveBeenCalled();
  unmount();
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it('rechecks a policy push racing the initial read and discards the earlier response', async () => {
  type Policy = { workdirKey: string; disabled: string[] };
  let changed!: (policy: Policy) => void;
  const requests: Array<(policy: Policy) => void> = [];
  Object.assign(window.electronAPI.ghosts, {
    workdirPrefs: () => new Promise<Policy>(resolve => requests.push(resolve)),
    onWorkdirPrefsChanged: (callback: typeof changed) => { changed = callback; return () => {}; },
  });
  const ghosts = [ghost('a')];
  const { result } = renderHook(() => useWorkdirDisabledGhostIds('/project', ghosts));
  await act(async () => {});
  await act(async () => changed({ workdirKey: '/project', disabled: ['a'] }));
  expect(requests).toHaveLength(2);
  await act(async () => requests[1]!({ workdirKey: '/project', disabled: ['a'] }));
  await act(async () => requests[0]!({ workdirKey: '/project', disabled: [] }));
  expect([...result.current!]).toEqual(['a']);
});

function Probe({ label }: { label: string }) {
  const ghosts = useInstalledGhosts();
  return <div data-testid={label}>{ghosts.map((g) => g.manifest.id).join(',')}</div>;
}

describe('useInstalledGhosts(窗口级共享缓存)', () => {
  it('remote composers can opt out of local synchronous IPC and subscriptions', () => {
    const { result, rerender } = renderHook(({ enabled }) => useInstalledGhosts(enabled), {
      initialProps: { enabled: false },
    });
    expect(result.current).toEqual([]);
    expect(listSync).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    rerender({ enabled: true });
    expect(result.current[0].manifest.id).toBe('cindy-art');
    rerender({ enabled: false });
    expect(result.current).toEqual([]);
  });
  it('多个消费者只触发一次 listSync,清单一致', () => {
    render(
      <>
        <Probe label="a" />
        <Probe label="b" />
        <Probe label="c" />
      </>,
    );
    expect(listSync).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('a').textContent).toBe('cindy-art');
    expect(screen.getByTestId('b').textContent).toBe('cindy-art');
    expect(screen.getByTestId('c').textContent).toBe('cindy-art');
  });

  it('后挂载的消费者复用缓存,不再 listSync', () => {
    const first = render(<Probe label="a" />);
    expect(listSync).toHaveBeenCalledTimes(1);
    first.rerender(
      <>
        <Probe label="a" />
        <Probe label="b" />
      </>,
    );
    expect(listSync).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('b').textContent).toBe('cindy-art');
  });

  it('ghosts:changed 推送后全体消费者刷新,且不重扫', () => {
    render(
      <>
        <Probe label="a" />
        <Probe label="b" />
      </>,
    );
    expect(changedCbs.length).toBeGreaterThan(0);
    act(() => {
      changedCbs.forEach((cb) =>
        cb({ ghosts: [ghost('cindy-art'), ghost('cindy-mermaid')] }),
      );
    });
    expect(screen.getByTestId('a').textContent).toBe('cindy-art,cindy-mermaid');
    expect(screen.getByTestId('b').textContent).toBe('cindy-art,cindy-mermaid');
    expect(listSync).toHaveBeenCalledTimes(1);
  });

  it('模块重置时退订旧 changed 回调,重新挂载只注册一个新回调', () => {
    const first = render(<Probe label="a" />);
    expect(onChanged).toHaveBeenCalledTimes(1);
    first.unmount();

    __resetInstalledGhostsStoreForTest();
    expect(unsubscribeChanged).toHaveBeenCalledTimes(1);

    render(<Probe label="b" />);
    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(listSync).toHaveBeenCalledTimes(2);
  });

  it('桥缺席(精简 harness)时空清单兜底,不抛错', () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {};
    render(<Probe label="a" />);
    expect(screen.getByTestId('a').textContent).toBe('');
  });
});

// #9580 关联审计：展示投影必须窗口级共享，不能按组件/通知叠加全量读取。
describe('plugin display projections', () => {
  it('shared projection reads once for many consumers and once per notification', async () => {
    const read = vi.fn(async () => ['ok']);
    const projection = createGhostDisplayProjection(read, [] as string[]);
    const a = renderHook(() => useGhostDisplayProjection(projection));
    const b = renderHook(() => useGhostDisplayProjection(projection));
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(1);
    expect(a.result.current).toEqual(['ok']);
    expect(b.result.current).toEqual(['ok']);
    act(() => changedCbs.forEach((cb) => cb({ ghosts: [] })));
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(2);
    a.unmount();
    b.unmount();
    projection.__resetForTest();
  });

  // 测试价值
  // - 生产入口与可观察结果：createGhostDisplayProjection/useGhostDisplayProjection；切账号后插件显示投影自动读到新账号数据。
  // - Bug／规则依据：#9580 关联审计发现的 owner 切换 in-flight 停更。
  // - 现有覆盖缺口：既有共享/通知用例没有覆盖旧请求未返回时切 owner。
  // - 最小失败输入：owner A 读取挂起 → 切 owner B 并渲染 → A 回包；旧实现不再读 B。
  // - tier：unit；内存 deferred，无真实等待。
  it('owner switch during an in-flight read schedules a new-owner refresh without a plugin notification', async () => {
    setDataOwnerGeneration('owner-a', 0);
    let resolveOld!: (value: string[]) => void;
    const read = vi.fn()
      .mockImplementationOnce(() => new Promise<string[]>(resolve => { resolveOld = resolve; }))
      .mockImplementation(async () => ['new-owner-plugin']);
    const projection = createGhostDisplayProjection(read, [] as string[]);
    const hook = renderHook(() => useGhostDisplayProjection(projection));
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(1);
    act(() => setDataOwnerGeneration('owner-b', 1));
    hook.rerender();
    await act(async () => { resolveOld(['old-owner-plugin']); });
    expect(read).toHaveBeenCalledTimes(2);
    expect(hook.result.current).toEqual(['new-owner-plugin']);
    hook.unmount();
    projection.__resetForTest();
  });

  it('workdir policy is shared across consumers and not re-read on roster change', async () => {
    const workdirPrefs = vi.fn(async () => ({ workdirKey: '/project', disabled: ['a'] }));
    Object.assign(window.electronAPI.ghosts, { workdirPrefs });
    const ghosts = [ghost('a')];
    const a = renderHook(({ gs }) => useWorkdirDisabledGhostIds('/project', gs), { initialProps: { gs: ghosts } });
    const b = renderHook(() => useWorkdirDisabledGhostIds('/project', ghosts));
    await act(async () => {});
    expect(workdirPrefs).toHaveBeenCalledTimes(1);
    a.rerender({ gs: [...ghosts, ghost('b')] });
    await act(async () => {});
    expect(workdirPrefs).toHaveBeenCalledTimes(1);
    expect([...a.result.current!]).toEqual(['a']);
    expect([...b.result.current!]).toEqual(['a']);
    a.unmount();
    b.unmount();
  });
});
