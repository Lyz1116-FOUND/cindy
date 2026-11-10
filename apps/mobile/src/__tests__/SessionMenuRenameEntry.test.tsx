// @vitest-environment jsdom
vi.mock('@/session/TaskTags', () => ({ TaskTagsPanel: () => <div data-testid="session.testTags" /> }));
vi.mock('@/session/SessionPrLinks', () => ({ SessionPrLinks: () => null }));
import { act, type ReactNode } from "react";
import { fireEvent } from '@testing-library/react';
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  SessionMenuSheet,
  type SessionMenuSheetProps,
} from "@/session/SessionMenuSheet";
import { i18n } from "@/i18n";
import { sharedTaskHostPeer } from '@cindy/device-link';

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  const view = ({
    children,
    onPress,
    testID,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    testID?: string;
  }) =>
    createElement("div", { onClick: onPress, "data-testid": testID }, children);
  return {
    Platform: { OS: 'android' },
    View: view,
    Pressable: view,
    Text: view,
    TextInput: view,
    ActivityIndicator: () => null,
    Alert: { alert: vi.fn() },
    Animated: {
      Value: class {
        setValue() {}
      },
      View: view,
      timing: () => ({ start: (done?: () => void) => done?.() }),
    },
    StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
    Easing: { bezier: () => (t: number) => t },
    AccessibilityInfo: {
      isReduceMotionEnabled: () => Promise.resolve(false),
      addEventListener: () => ({ remove() {} }),
    },
    useWindowDimensions: () => ({ height: 800, width: 400 }),
  };
});
vi.mock("@/components/AppText", async () => {
  const rn = await import("react-native");
  const { createElement } = await import("react");
  return {
    Text: rn.Text,
    TextInput: ({ value, onChangeText, onSubmitEditing, testID }: { value?: string; onChangeText?: (value: string) => void; onSubmitEditing?: () => void; testID?: string }) =>
      createElement('input', { value, 'data-testid': testID, onChange: (e: { target: { value: string } }) => onChangeText?.(e.target.value), onKeyDown: (e: { key: string }) => { if (e.key === 'Enter') onSubmitEditing?.(); } }),
  };
});
vi.mock("lucide-react-native", () =>
  Object.fromEntries(
    [
      "Archive",
      "ArchiveRestore",
      "ChevronRight",
      "Copy",
      "Folder",
      "GitBranch",
      "Link2",
      "LogOut",
      "Monitor",
      "Pencil",
      "Pin",
      "PinOff",
      "RefreshCw",
      "Search",
      "Sparkles",
      "Trash2",
    ].map((name) => [name, () => null]),
  ),
);
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("@/theme", async () => {
  const tokens = await import("@/theme/tokens");
  return {
    ...tokens,
    monoFont: "monospace",
    useTheme: () => ({ colors: tokens.lightColors }),
    useThemedStyles: (make: (colors: typeof tokens.lightColors) => unknown) =>
      make(tokens.lightColors),
  };
});
vi.mock("@/components/MobilePrimitives", async () => {
  const { createElement } = await import("react");
  type Action = { onPress(): void; testID: string };
  return {
    MainWindowActionButton: () => null,
    MainWindowActionGroup: ({ primaryActions, cancelAction }: { primaryActions: Action[]; cancelAction?: Action }) =>
      createElement("div", null, [...primaryActions, ...(cancelAction ? [cancelAction] : [])].map((action) =>
        createElement("button", { key: action.testID, "data-testid": action.testID, onClick: action.onPress }))),
  };
});
const sheetLifecycle = vi.hoisted(() => ({ closed: undefined as (() => void) | undefined }));
vi.mock("@/session/SheetModal", () => ({
  SheetModal: ({ children, onClosed }: { children: ReactNode; onClosed?: () => void }) => {
    sheetLifecycle.closed = onClosed;
    return children;
  },
}));
vi.mock("@/session/SheetSurface", () => ({
  SheetSurface: ({ children, footer }: { children: ReactNode; footer?: ReactNode }) => <>{children}{footer}</>,
}));
vi.mock("@/session/messageActions", () => ({ writeClipboardText: vi.fn(), formatModelShortLabel: (id: string) => id }));

function baseProps(overrides: Partial<SessionMenuSheetProps> = {}) {
  const reader = {
    getContextUsage: vi.fn(async () => ({ totalTokens: 20, rawMaxTokens: 100 })),
    getCodexRateLimits: vi.fn(),
    getAccountUsage: vi.fn(),
    getSessionEstimatedValue: vi.fn(async () => ({})),
  };
  return {
    usageReader: reader,
    onContextError: vi.fn(),
    onRefreshAccountUsage: vi.fn(),
    onOpenSearch: vi.fn(),
    onRename: vi.fn(),
    onClose: vi.fn(),
    session: { id: "a", model: "custom", providerId: "custom", agentKind: "pi", title: "Task" },
    initialView: "rename",
    visible: true,
    busy: false,
    ...overrides,
  } as unknown as SessionMenuSheetProps;
}

async function renderSheet(props: SessionMenuSheetProps, locale = 'zh-CN') {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  await i18n.changeLanguage(locale);
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<SessionMenuSheet {...props} />));
  const click = async (testID: string) => {
    const node = host.querySelector(`[data-testid="${testID}"]`) as HTMLElement | null;
    if (!node) throw new Error(`missing ${testID}`);
    await act(async () => node.click());
  };
  return { host, root, click };
}

// 测试价值
// - 生产入口与可观察结果：SessionMenuSheet 重命名输入与确定按钮；未改默认显示名不写，主动输入存储默认名要写。
// - Bug／规则依据：#9580 titleCustomized 同名保留。
// - 现有覆盖缺口：既有用例只覆盖普通标题/关闭，没有内置跟进默认名与存储名不同的分支。
// - 最小失败输入：en 界面预填 Follow assigned sessions (built-in)，用户输入 跟进任务。
// - tier：unit；真实组件 + DOM 输入事件。
it.each([
  ['Follow assigned sessions (built-in)', false],
  ['跟进任务', true],
])('built-in follow-up rename submits only an intentional change (%s)', async (value, shouldSubmit) => {
  const props = baseProps({
    session: {
      ...baseProps().session,
      id: 'follow', title: '跟进任务', source: 'bot', titleCustomized: false,
      companion: { id: 'bot', role: 'routine', routineId: 'builtin-follow-up-bot' },
    },
  });
  const { host, root, click } = await renderSheet(props, 'en');
  try {
    const input = host.querySelector('[data-testid="session.renameInput"]') as HTMLInputElement;
    expect(input.value).toBe('Follow assigned sessions (built-in)');
    await act(async () => { fireEvent.change(input, { target: { value } }); });
    await click('session.renameButton');
    if (shouldSubmit) expect(props.onRename).toHaveBeenCalledWith('跟进任务');
    else expect(props.onRename).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});

it("opening at rename goes straight to the editor and cancel closes the sheet", async () => {
  const props = baseProps();
  const { host, root, click } = await renderSheet(props);
  try {
    expect(host.querySelector('[data-testid="session.renameBlock"]')).not.toBeNull();
    await click("session.renameCancelButton");
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onRename).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});

// Unit: a slow archive preflight used to hold the menu open. The actual menu
// must close immediately, but wait for native dismissal before opening an Alert.
it.each([true, false])("archive closes the menu before a delayed decision (%s)", async (confirmed) => {
  let decide!: (ok: boolean) => void;
  const decision = new Promise<boolean>((resolve) => { decide = resolve; });
  const commit = vi.fn();
  const onArchive = vi.fn(async (prepare: (isCurrent: () => boolean) => Promise<boolean>) => {
    if (await prepare(() => true)) commit();
  });
  const props = baseProps({ initialView: "menu", onArchive, confirmArchive: vi.fn(() => decision),
    session: { id: "a", title: "Task", status: "active" } as SessionMenuSheetProps['session'] });
  const { root, click } = await renderSheet(props);
  try {
    await click("session.archiveButton");
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(onArchive).not.toHaveBeenCalled();
    expect(props.confirmArchive).not.toHaveBeenCalled();
    await act(async () => sheetLifecycle.closed?.());
    expect(props.confirmArchive).toHaveBeenCalledOnce();
    expect(onArchive).toHaveBeenCalledExactlyOnceWith(props.confirmArchive);
    expect(commit).not.toHaveBeenCalled();
    await act(async () => { decide(confirmed); });
    expect(commit).toHaveBeenCalledTimes(confirmed ? 1 : 0);
  } finally {
    await act(async () => root.unmount());
  }
});

it("confirming a direct rename closes the sheet", async () => {
  const props = baseProps();
  const { root, click } = await renderSheet(props);
  try {
    await click("session.renameButton");
    expect(props.onClose).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
  }
});

it("renaming from the menu returns to the menu instead of closing", async () => {
  const props = baseProps({ initialView: "menu" });
  const { host, root, click } = await renderSheet(props);
  try {
    expect(host.querySelector('[data-testid="session.renameBlock"]')).toBeNull();
    await click("session.renameAction");
    expect(host.querySelector('[data-testid="session.renameBlock"]')).not.toBeNull();
    await click("session.renameCancelButton");
    expect(props.onClose).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="session.renameBlock"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it.each([
  ["host-managed", { messageOnly: true }],
  ["worker", { session: { id: "a", title: "Task", orcaRole: "worker" } }],
  ["shared guest", { session: { id: "a", title: "Task", deviceLinkDeviceId: sharedTaskHostPeer("shared", "desktop") } }],
  ["busy", { busy: true }],
] as const)("a %s task does not open the rename editor", async (_name, overrides) => {
  const props = baseProps(overrides as Partial<SessionMenuSheetProps>);
  const { host, root } = await renderSheet(props);
  try {
    expect(host.querySelector('[data-testid="session.renameBlock"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

// PR #6529 replaces the brittle source guard with the production menu. Unit:
// a Worker has archive enabled; the old checks did not exercise confirmation.
// Ordinary rename cases above cannot catch the iOS failure where closing the
// sheet before confirmation loses the Alert. Close only after onConfirmed.
it("Worker details hide ordinary actions and wait for archive confirmation before closing", async () => {
  const onArchive = vi.fn();
  const props = baseProps({ initialView: "menu", worker: { onArchive },
    session: { id: "worker", title: "Worker", orcaRole: "worker", status: "active" } as SessionMenuSheetProps['session'] });
  const { host, root, click } = await renderSheet({ ...props, session: { ...props.session, orcaRole: undefined } });
  const ordinaryActions = ["session.renameAction", "session.copyLinkAction", "session.detailsSearch",
    "session.pinButton", "session.archiveButton", "session.deleteButton", "session.testTags"];
  try {
    for (const id of ordinaryActions) {
      expect(host.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
    await act(async () => root.render(<SessionMenuSheet {...props} />));
    for (const id of ordinaryActions) {
      expect(host.querySelector(`[data-testid="${id}"]`)).toBeNull();
    }
    await click("session.workerArchive");
    expect(onArchive).toHaveBeenCalledExactlyOnceWith(props.onClose);
    expect(props.onClose).not.toHaveBeenCalled();
    await act(async () => onArchive.mock.calls[0]![0]());
    expect(props.onClose).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); }
});
