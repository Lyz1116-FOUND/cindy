/** @vitest-environment jsdom */
/**
 * sessionSearch — vitest unit tests
 *
 * #9580: 原标题过滤不能命中英文可见名，hook 也未订阅语言变化。
 * 生产入口为 computeSessionSearchView / useSessionSearch；原有纯函数用例没有覆盖这两处。
 * 最小失败输入：内置跟进默认标题 + en + query=follow，或挂载后 en → ja。
 * unit: 合成任务与内存 i18n，真实 hook 重渲染，不读用户数据库。
 *
 * 配套覆盖：fuzzyMatch 评分 → fuzzyMatch.test.ts；高亮 → highlightSegments.test.ts。
 */

import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';

import { computeSessionSearchView } from '@/features/cc-agent/lib/sessionSearch';
import { useSessionSearch } from '@/features/cc-agent/hooks/useSessionSearch';
import { canHighlightSessionDisplayTitle } from '@/features/cc-agent/lib/sessionDisplayTitle';
import { FOLLOW_UP_ROUTINE_NAME } from '../../shared/botAutonomy';
import en from '../i18n/locales/en/common.json';
import ja from '../i18n/locales/ja/common.json';
import type { Session } from '@/lib/ccAgent.types';

/* ---------------- helpers ---------------- */

function s(partial: Partial<Session> & { id: string; title: string }): Session {
  return {
    userId: 'u',
    workingDir: null,
    workspaceKind: 'project',
    agentKind: 'cc',
    status: 'active',
    pinnedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    userSendAt: '2026-01-01T00:00:00.000Z',
    _count: { messages: 1 },
    ...partial,
  } as Session;
}

const SAMPLE: Session[] = [
  s({ id: '1', title: 'Refactor session header' }),
  s({ id: '2', title: 'Fix chat blank middle' }),
  s({ id: '3', title: 'Add project bar search' }),
  s({ id: '4', title: 'session-grouping refactor' }),
  s({ id: '5', title: 'unrelated thing' }),
];

/* ---------------- INACTIVE: empty / whitespace query ---------------- */

describe('computeSessionSearchView — INACTIVE (empty / whitespace query)', () => {
  it('empty query returns input by reference + empty matchMap + isFiltering=false', () => {
    const view = computeSessionSearchView(SAMPLE, '');
    expect(view.filtered).toBe(SAMPLE);
    expect(view.matchMap.size).toBe(0);
    expect(view.isFiltering).toBe(false);
  });

  it('whitespace-only query also treated as INACTIVE (trim semantics)', () => {
    const view = computeSessionSearchView(SAMPLE, '   ');
    expect(view.filtered).toBe(SAMPLE);
    expect(view.isFiltering).toBe(false);
  });
});

/* ---------------- ACTIVE: non-empty query ---------------- */

describe('computeSessionSearchView — ACTIVE (non-empty query)', () => {
  it('filters out non-matching items', () => {
    const view = computeSessionSearchView(SAMPLE, 'session');
    const ids = view.filtered.map((x) => x.id);
    expect(ids).toContain('1');
    expect(ids).toContain('4');
    expect(ids).not.toContain('2');
    expect(ids).not.toContain('5');
    expect(view.isFiltering).toBe(true);
  });

  it('builds matchMap with indices for every filtered item', () => {
    const view = computeSessionSearchView(SAMPLE, 'fix');
    expect(view.matchMap.has('2')).toBe(true);
    expect(view.matchMap.get('2')?.length).toBe(3);
    expect(view.matchMap.has('5')).toBe(false);
  });

  it('orders by score (prefix wins over scattered)', () => {
    const view = computeSessionSearchView(SAMPLE, 'session');
    // id=4 ("session-grouping refactor") 是真正的前缀,排第一
    expect(view.filtered[0].id).toBe('4');
  });
});

// #9580: 只补受影响任务的显示名候选，不改变原标题、普通任务或空查询合同。
describe('built-in follow-up search', () => {
  const english = (key: string) => key === 'routines.builtinFollowUp.name'
    ? en.routines.builtinFollowUp.name
    : key;
  const followUp = s({
    id: 'follow-up',
    title: FOLLOW_UP_ROUTINE_NAME,
    source: 'bot',
    companion: { id: 'analysis-bot', role: 'routine', routineId: 'builtin-follow-up-analysis-bot' },
  });

  it.each(['follow', '跟进'])('finds %s once and returns the original session', (query) => {
    const view = computeSessionSearchView([followUp], query, english);
    expect(view.filtered).toHaveLength(1);
    expect(view.filtered[0]).toBe(followUp);
    expect(view.filtered[0].title).toBe(FOLLOW_UP_ROUTINE_NAME);
    expect(view.matchMap.size).toBe(1);
    expect(canHighlightSessionDisplayTitle(followUp, english)).toBe(false);
    expect(canHighlightSessionDisplayTitle(followUp)).toBe(true);
  });

  it('ranks both title candidates together without changing existing prefix ordering', () => {
    const ordinary = s({ id: 'ordinary', title: 'Follow-up notes' });
    const view = computeSessionSearchView([followUp, ordinary], 'follow', english);
    expect(view.filtered.map((session) => session.id)).toEqual(['ordinary', 'follow-up']);
    expect(view.filtered[1]).toBe(followUp);
  });

  it('does not translate ordinary titles or titles without routine attribution', () => {
    const ordinary = s({ id: 'ordinary', title: FOLLOW_UP_ROUTINE_NAME });
    const legacy = { ...followUp, companion: undefined };
    expect(computeSessionSearchView([ordinary, legacy], 'follow', english).filtered).toEqual([]);
  });

  it('keeps the input reference for an empty query and original matching without a translator', () => {
    const sessions = [followUp];
    expect(computeSessionSearchView(sessions, '', english).filtered).toBe(sessions);
    expect(computeSessionSearchView(sessions, 'follow').filtered).toEqual([]);
    expect(computeSessionSearchView(sessions, '跟进').filtered[0]).toBe(followUp);
  });

  it('recomputes an open search when the interface language changes', async () => {
    const i18n = createInstance();
    await i18n.use(initReactI18next).init({
      lng: 'en',
      fallbackLng: 'en',
      resources: { en: { common: en }, ja: { common: ja } },
    });
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      I18nextProvider,
      { i18n, defaultNS: 'common' },
      children,
    );
    const { result } = renderHook(() => useSessionSearch([followUp]), { wrapper });
    act(() => result.current.setQuery('follow'));
    expect(result.current.filtered[0]).toBe(followUp);

    await act(async () => { await i18n.changeLanguage('ja'); });
    expect(result.current.filtered).toEqual([]);
    act(() => result.current.setQuery(ja.routines.builtinFollowUp.name));
    expect(result.current.filtered[0]).toBe(followUp);
  });
});

/* ---------------- edge cases ---------------- */

describe('computeSessionSearchView — edge cases', () => {
  it('empty sessions list with non-empty query → empty filtered + empty matchMap + isFiltering=true', () => {
    const view = computeSessionSearchView([], 'anything');
    expect(view.filtered).toEqual([]);
    expect(view.matchMap.size).toBe(0);
    expect(view.isFiltering).toBe(true);
  });

  it('query that matches nothing → empty filtered + isFiltering=true', () => {
    const view = computeSessionSearchView(SAMPLE, 'zzzzzzz');
    expect(view.filtered.length).toBe(0);
    expect(view.isFiltering).toBe(true);
  });

  it('empty sessions + empty query → returns input ref', () => {
    const empty: Session[] = [];
    const view = computeSessionSearchView(empty, '');
    expect(view.filtered).toBe(empty);
    expect(view.isFiltering).toBe(false);
  });
});
