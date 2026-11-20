import React, { useState } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PAGE_COMMON } from '@/process/services/workbench/replies/platforms/shared';
import { DOUYIN_PAGE } from '@/process/services/workbench/replies/platforms/douyin';

afterEach(cleanup);

const readVersion = new Function(
  'element',
  `${PAGE_COMMON}\nreturn fiberProps(element, p => typeof p.version === 'number')?.version;`
) as (element: Element) => number | undefined;
const readVersions = new Function(
  'first',
  'second',
  `${PAGE_COMMON}\nreturn [first, second].map(element => fiberProps(element, p => typeof p.version === 'number')?.version);`
) as (first: Element, second: Element) => number[];
const readThread = new Function(
  'element',
  'total',
  `const A = {}; ${PAGE_COMMON}\n${DOUYIN_PAGE}\nreturn replyComponents(element, 'root', total).map(node => ({ total: node.memoizedProps.replyTotal, state: node.memoizedState.memoizedState }));`
) as (element: Element, total: number) => Array<{ total: number; state: string }>;

function StaticMarker({ version }: { version: number }) {
  return <div>{version}</div>;
}

const threadProps = (total: number) => ({
  levelOneCid: 'root',
  originCommentInfo: { cid: 'root', replyTotal: total },
  replyTotal: total,
  defaultReply: [],
  fetchReply: () => {},
});

describe('current React fibers', () => {
  it('reads the mounted branch and both directions of a React update', () => {
    let setValue!: React.Dispatch<React.SetStateAction<string>>;
    function Marker({ version }: { version: number }) {
      const [value, set] = useState('old');
      setValue = set;
      return <div data-testid='marker'>{`${version}:${value}`}</div>;
    }
    const view = render(<Marker version={1} />);
    const marker = view.getByTestId('marker');
    expect(readVersion(marker)).toBe(1);
    act(() => {
      setValue('new');
      view.rerender(<Marker version={2} />);
    });
    expect(marker).toHaveTextContent('2:new');
    expect(readVersion(marker)).toBe(2);
    act(() => {
      setValue('newer');
      view.rerender(<Marker version={3} />);
    });
    expect(marker).toHaveTextContent('3:newer');
    expect(readVersion(marker)).toBe(3);
  });

  it('reads reply component props and hook state from the current branch', () => {
    let setValue!: React.Dispatch<React.SetStateAction<string>>;
    function Thread(_props: {
      levelOneCid: string;
      originCommentInfo: { cid: string; replyTotal: number };
      replyTotal: number;
      defaultReply: unknown[];
      fetchReply: () => void;
    }) {
      const [value, set] = useState('old');
      setValue = set;
      return <section data-testid='thread'>{value}</section>;
    }
    const view = render(<Thread {...threadProps(1)} />);
    const thread = view.getByTestId('thread');
    expect(readThread(thread, 1)).toEqual([{ total: 1, state: 'old' }]);
    act(() => {
      setValue('current');
      view.rerender(<Thread {...threadProps(2)} />);
    });
    expect(readThread(thread, 2)).toEqual([{ total: 2, state: 'current' }]);
  });

  it('keeps different mounted roots separate and rejects an unprovable fiber', () => {
    const first = render(<StaticMarker version={1} />);
    const second = render(<StaticMarker version={2} />);
    expect(readVersions(first.container.firstElementChild!, second.container.firstElementChild!)).toEqual([1, 2]);
    const unknown = document.createElement('div');
    Object.defineProperty(unknown, '__reactFiber$unverified', { value: { memoizedProps: { version: 99 } } });
    expect(() => readVersion(unknown)).toThrow(/REPLY_FIBER_UNVERIFIED/);
  });

  it('rejects an element no longer reachable from the committed root', () => {
    const view = render(<StaticMarker version={1} />);
    const old = view.container.firstElementChild!;
    view.rerender(<div>Replacement</div>);
    expect(readVersion(old)).toBeUndefined();
  });

  it('indexes each committed root once per page evaluation', () => {
    const first = document.createElement('div');
    const second = document.createElement('div');
    const owner: { current?: object } = {};
    let reads = 0;
    const root = { tag: 3, stateNode: owner, return: null };
    const left = {
      tag: 5,
      stateNode: first,
      memoizedProps: { version: 1 },
      return: root,
      sibling: null as object | null,
    };
    const right = { tag: 5, stateNode: second, memoizedProps: { version: 2 }, return: root, sibling: null };
    left.sibling = right;
    Object.defineProperty(root, 'child', { get: () => (reads++, left) });
    owner.current = root;
    Object.defineProperty(first, '__reactFiber$test', { value: left });
    Object.defineProperty(second, '__reactFiber$test', { value: right });
    expect(readVersions(first, second)).toEqual([1, 2]);
    expect(reads).toBeLessThanOrEqual(2);
  });
});
