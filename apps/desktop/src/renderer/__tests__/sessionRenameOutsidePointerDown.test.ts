// @vitest-environment jsdom

/**
 * sessionRenameOutsidePointerDown.test.ts
 * ---------------------------------------------------------------------------
 * 回归覆盖(点击编辑器外任何位置 = 提交并结束编辑):
 * 点击不可聚焦区域(聊天区空白等)不会转移焦点、blur 不触发,只靠 blur
 * 编辑态会一直挂着 —— SessionRenameInput 用 document pointerdown capture
 * 做外点检测。
 * - 容器外 pointerdown → onCommit(当前 value);
 * - 容器内(input / Magic 按钮)pointerdown → 不提交;
 * - 输入修改后外点 → 提交的是最新值;
 * - 卸载后 document 监听移除,不再触发。
 */

import { createElement, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionRenameInput } from '../features/cc-agent/SessionRenameInput';
import { SessionTabsBar } from '../features/cc-agent/workdir-browse/SessionTabsBar';
import type { Session } from '@/lib/ccAgent.types';

vi.mock('@/lib/makerTransport', () => ({
  regenerateSessionTitleFor: vi.fn(),
}));
vi.mock('@/lib/makerChatStore', () => {
  const running = new Map();
  return { makerChatStore: { subscribeAll: () => () => {}, getRunningSnapshot: () => running } };
});
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key === 'routines.builtinFollowUp.name' ? 'Follow assigned sessions (built-in)' : key,
    i18n: { language: 'en' },
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** 受控 value 的最小宿主:模拟调用方的 draft state。 */
function Harness(props: { onCommit: (raw: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState('旧标题');
  return createElement(SessionRenameInput, {
    sessionId: 's1',
    value,
    onValueChange: setValue,
    onCommit: props.onCommit,
    onCancel: props.onCancel,
  });
}

describe('SessionRenameInput outside pointerdown commits', () => {
  it('pointerdown outside the container commits the current value', () => {
    const onCommit = vi.fn();
    render(createElement(Harness, { onCommit, onCancel: () => {} }));

    fireEvent.pointerDown(document.body);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('旧标题');
  });

  it('pointerdown inside the container (input / magic button) does not commit', () => {
    const onCommit = vi.fn();
    const { container } = render(createElement(Harness, { onCommit, onCancel: () => {} }));

    fireEvent.pointerDown(container.querySelector('input')!);
    fireEvent.pointerDown(container.querySelector('button')!);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commits the latest edited value on outside pointerdown', () => {
    const onCommit = vi.fn();
    const { container } = render(createElement(Harness, { onCommit, onCancel: () => {} }));

    fireEvent.change(container.querySelector('input')!, { target: { value: '新标题' } });
    fireEvent.pointerDown(document.body);
    expect(onCommit).toHaveBeenCalledWith('新标题');
  });

  it('removes the document listener after unmount', () => {
    const onCommit = vi.fn();
    const { unmount } = render(createElement(Harness, { onCommit, onCancel: () => {} }));

    unmount();
    fireEvent.pointerDown(document.body);
    expect(onCommit).not.toHaveBeenCalled();
  });
});

// #9580: tab 重命名原来把显示名直接交给 onRename；内置默认名原样确认不能产生写入。
// unit: 真实 SessionTabsBar + 内存 session；最小失败输入为 en 默认显示名 + Enter/Blur。
describe('SessionTabsBar built-in follow-up rename', () => {
  const followUp = {
    id: 's1', title: '跟进任务', source: 'bot', agentKind: 'codex',
    companion: { id: 'bot', role: 'routine', routineId: 'builtin-follow-up-bot' },
  } as Session;

  function renderTabs(onRename: (id: string, title: string) => void) {
    return render(createElement(SessionTabsBar, {
      activeSessionId: 's1', sessions: [followUp], canCreateNew: false,
      onActivate: () => {}, onCreateNew: () => {}, onClose: () => {}, onRename,
    }));
  }

  it('does not emit a rename when the localized default title is confirmed unchanged', () => {
    const onRename = vi.fn();
    renderTabs(onRename);
    fireEvent.doubleClick(screen.getByText('Follow assigned sessions (built-in)'));
    const input = screen.getByRole('textbox');
    expect(input).toHaveProperty('value', 'Follow assigned sessions (built-in)');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    expect(onRename).not.toHaveBeenCalled();
  });

  it('still emits a real custom rename once across Enter and Blur', () => {
    const onRename = vi.fn();
    renderTabs(onRename);
    fireEvent.doubleClick(screen.getByText('Follow assigned sessions (built-in)'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'My task tracker' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith('s1', 'My task tracker');
  });
});
