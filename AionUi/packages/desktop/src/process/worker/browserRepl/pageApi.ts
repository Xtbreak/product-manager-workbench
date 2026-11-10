import type { BrowserRpc } from '../../services/workbench/browserRepl';
type AxNode = {
  ignored?: boolean;
  backendDOMNodeId?: number;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: string };
};
type Evaluation = {
  result?: { value?: unknown; objectId?: string; subtype?: string; description?: string };
  exceptionDetails?: { text: string };
};
const unwrap = (result: Evaluation): unknown => {
  if (result.exceptionDetails || result.result?.subtype === 'error')
    throw new Error(result.result?.description ?? result.exceptionDetails?.text ?? 'Page evaluation failed');
  return result.result?.value;
};
/** Small Playwright-style surface over explicit-account CDP. */
export function createBrowserApi(rpc: BrowserRpc) {
  return {
    accounts: () => rpc({ action: 'accounts' }),
    page: (accountId: string) => {
      if (!accountId) throw new Error('An explicit accountId is required.');
      const command = (method: string, params: Record<string, unknown> = {}) =>
        rpc({ action: 'browser', accountId, method, params });
      const evaluate = async (expression: string | ((arg: never) => unknown), arg?: unknown) => {
        const source =
          typeof expression === 'function'
            ? `(${expression.toString()})(${JSON.stringify(arg) ?? 'undefined'})`
            : expression;
        // Reject unsupported delayed page work; cancellation owns the REPL, not the site's event loop.
        // This conservative API check is not a JavaScript security sandbox.
        if (
          /\b(async|await|Promise|setTimeout|setInterval|requestAnimationFrame|queueMicrotask|fetch|XMLHttpRequest|Worker|addEventListener|eval|Function)\b/.test(
            source
          )
        )
          throw new Error('Page evaluate supports synchronous DOM extraction only. Wait and orchestrate in the REPL.');
        const result = (await command('Runtime.evaluate', {
          expression: source,
          returnByValue: true,
          awaitPromise: false,
          timeout: 5000,
        })) as Evaluation;
        if (result.result?.subtype === 'promise') throw new Error('Page evaluate supports synchronous results only.');
        return unwrap(result);
      };
      const tree = async () =>
        ((await command('Accessibility.getFullAXTree')) as { nodes: AxNode[] }).nodes.filter(
          (n) => !n.ignored && n.backendDOMNodeId
        );
      const mouseClick = async (x: number, y: number, clickCount = 1) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Click coordinates must be finite.');
        await command('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount });
        await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount });
      };
      const wheel = async (deltaX: number, deltaY: number, point: { x: number; y: number }) => {
        if (![deltaX, deltaY, point?.x, point?.y].every(Number.isFinite))
          throw new Error('Wheel requires finite deltas and a viewport point.');
        await command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX, deltaY });
        return { dispatched: true, instruction: 'Inspect the resulting viewport before the next action.' };
      };
      const press = async (key: string) => {
        const parts = key.split('+');
        const name = parts.pop()!;
        const modifiers =
          (parts.includes('Alt') ? 1 : 0) |
          (parts.includes('Control') ? 2 : 0) |
          (parts.includes('Meta') ? 4 : 0) |
          (parts.includes('Shift') ? 8 : 0);
        const codes: Record<string, number> = {
          Enter: 13,
          Tab: 9,
          Escape: 27,
          Backspace: 8,
          Delete: 46,
          ArrowDown: 40,
          ArrowUp: 38,
          ArrowLeft: 37,
          ArrowRight: 39,
          Home: 36,
          End: 35,
        };
        const params = { key: name, modifiers, windowsVirtualKeyCode: codes[name] ?? name.toUpperCase().charCodeAt(0) };
        await command('Input.dispatchKeyEvent', {
          ...params,
          type: 'keyDown',
          ...(parts.includes('Meta') && name.toLowerCase() === 'a' ? { commands: ['selectAll'] } : {}),
        });
        await command('Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
      };
      const locator = (query: {
        selector?: string;
        role?: string;
        text?: string;
        name?: string;
        exact?: boolean;
        ref?: number;
      }) => {
        const elementCall = async (body: string) => {
          let backendId = query.ref;
          if (query.role) {
            const matches = (await tree()).filter(
              (n) =>
                n.role?.value === query.role &&
                (query.name === undefined ||
                  (query.exact === false ? n.name?.value?.includes(query.name) : n.name?.value === query.name))
            );
            if (matches.length !== 1)
              throw new Error(
                `Expected one ${query.role}, found ${matches.length}. Refresh snapshot and refine locator.`
              );
            backendId = matches[0].backendDOMNodeId;
          }
          if (backendId) {
            const resolved = (await command('DOM.resolveNode', { backendNodeId: backendId })) as {
              object?: { objectId?: string };
            };
            if (!resolved.object?.objectId) throw new Error('Stale element reference. Refresh snapshot.');
            try {
              return unwrap(
                (await command('Runtime.callFunctionOn', {
                  objectId: resolved.object.objectId,
                  functionDeclaration: `function(){const el=this; ${body}}`,
                  returnByValue: true,
                  awaitPromise: true,
                })) as Evaluation
              );
            } finally {
              await command('Runtime.releaseObject', { objectId: resolved.object.objectId });
            }
          }
          const selection = query.selector
            ? `Array.from(document.querySelectorAll(${JSON.stringify(query.selector)}))`
            : `Array.from(document.querySelectorAll('body *')).filter(el => ${query.exact === false ? `el.textContent.includes(${JSON.stringify(query.text)})` : `el.textContent.trim() === ${JSON.stringify(query.text)}`}).filter(el => !Array.from(el.children).some(child => child.textContent.trim() === el.textContent.trim()))`;
          return evaluate(
            `(() => { const matches=${selection}; if(matches.length !== 1) throw new Error('Expected one element, found '+matches.length); const el=matches[0]; ${body} })()`
          );
        };
        const point = () =>
          elementCall(
            `if(!el.isConnected) throw new Error('Detached element'); el.scrollIntoView({block:'center',inline:'center'}); const r=el.getBoundingClientRect(); if(!r.width || !r.height || el.disabled) throw new Error('Element is hidden or disabled'); const x=r.x+r.width/2,y=r.y+r.height/2; const hit=document.elementFromPoint(x,y); if(hit !== el && !el.contains(hit)) throw new Error('Element is covered'); return {x,y};`
          ) as Promise<{ x: number; y: number }>;
        return {
          click: async () => {
            const p = await point();
            await mouseClick(p.x, p.y);
          },
          fill: async (text: string) => {
            await elementCall(
              `if(el.disabled || el.readOnly || !(el.matches('input,textarea') || el.isContentEditable)) throw new Error('Element is not editable'); el.focus(); if(el.select) el.select(); else {const r=document.createRange();r.selectNodeContents(el);const s=getSelection();s.removeAllRanges();s.addRange(r);}`
            );
            if (text) await command('Input.insertText', { text });
            else await press('Backspace');
          },
          press: async (key: string) => {
            await elementCall('el.focus();');
            await press(key);
          },
          textContent: () => elementCall('return el.textContent;'),
          inputValue: () => elementCall('return el.value;'),
          scroll: async (x: number, y: number) => wheel(x, y, await point()),
        };
      };
      return {
        accountId,
        copySelection: () => rpc({ action: 'copy', accountId }),
        evaluate,
        goto: async (url: string) => {
          if (!/^https?:\/\//.test(url)) throw new Error('Navigation requires an HTTP(S) URL.');
          const result = (await command('Page.navigate', { url })) as { errorText?: string };
          if (result.errorText) throw new Error(result.errorText);
          return result;
        },
        url: () => evaluate('location.href'),
        snapshot: async () =>
          (await tree())
            .filter((n) => !['none', 'generic', 'InlineTextBox'].includes(n.role?.value ?? ''))
            .slice(0, 250)
            .map(
              (n) =>
                `[ref=${n.backendDOMNodeId}] ${n.role?.value ?? ''} ${JSON.stringify(n.name?.value ?? '')}${n.value?.value ? ` value=${JSON.stringify(n.value.value)}` : ''}`
            )
            .join('\n')
            .slice(0, 24000),
        locator: (selector: string) =>
          /^@?\d+$/.test(selector) ? locator({ ref: Number(selector.replace('@', '')) }) : locator({ selector }),
        getByRole: (role: string, options: { name?: string; exact?: boolean } = {}) => locator({ role, ...options }),
        getByText: (text: string, options: { exact?: boolean } = {}) => locator({ text, ...options }),
        mouse: { click: mouseClick, wheel },
        keyboard: { press, type: (text: string) => command('Input.insertText', { text }) },
        scroll: (x: number, y: number) => evaluate(`window.scrollBy(${Number(x)}, ${Number(y)})`),
        screenshot: () => command('Page.captureScreenshot', { format: 'png' }),
        waitForFunction: async (expression: string, timeoutMs = 10000) => {
          const deadline = Date.now() + Math.min(timeoutMs, 30000);
          do {
            if (await evaluate(expression)) return true;
            await new Promise((r) => setTimeout(r, 100));
          } while (Date.now() < deadline);
          throw new Error('Page condition timed out.');
        },
      };
    },
  };
}
