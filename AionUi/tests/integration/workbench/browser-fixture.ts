import { app, BrowserWindow, session, ipcMain } from 'electron';
import { writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startCdpBridge } from '../../../packages/desktop/src/process/resources/builtinMcp/cdpBridge';
const [profile, serverPath, output] = process.argv.slice(2);
app.setPath('userData', profile);
let closeOnFailure = async (): Promise<void> => {};
void app
  .whenReady()
  .then(async () => {
    const bridge = await startCdpBridge({
      focus: async (contentsId) => {
        await win.webContents.executeJavaScript(
          `Array.from(document.querySelectorAll('webview')).find(v => v.getWebContentsId() === ${contentsId}).focus()`
        );
      },
    });
    const ids = ['primary', 'second', 'feishu'];
    for (const id of ids) {
      session.fromPartition(`persist:${id}`).protocol.handle(
        'https',
        () =>
          new Response(
            `<html><head><title>${id}</title></head><body><textarea id="grid"></textarea><div id="scroller" style="position:absolute;top:60px;left:8px;width:160px;height:70px;overflow:auto"><div style="width:1000px;height:40px">scroll test</div></div></body></html>`,
            {
              headers: { 'content-type': 'text/html' },
            }
          )
      );
    }
    const win = new BrowserWindow({
      show: false,
      webPreferences: { webviewTag: true, nodeIntegration: true, contextIsolation: false },
    });
    const ready = new Promise<void>((resolve) => {
      const registered = new Set();
      ipcMain.on('fixture-ready', (_event, id: string, contentsId: number) => {
        const result = bridge.attach(contentsId, { accountId: id, name: id });
        if (!result.ok) throw new Error(result.reason);
        registered.add(id);
        if (registered.size === 3) resolve();
      });
    });
    await win.loadURL(
      'data:text/html,' +
        encodeURIComponent(
          `<html><body>${ids.map((id) => `<webview id="${id}" partition="persist:${id}" src="${id === 'feishu' ? 'https://test.feishu.cn/base/test?table=tbl1' : 'https://www.xiaohongshu.com/explore/test'}"></webview>`).join('')}<script>for(const view of document.querySelectorAll('webview')) view.addEventListener('dom-ready',()=>require('electron').ipcRenderer.send('fixture-ready',view.id,view.getWebContentsId()))</script></body></html>`
        )
    );
    await ready;
    const client = new Client({ name: 'workbench-integration', version: '1' });
    closeOnFailure = async () => {
      await client.close();
      await bridge.close();
      win.destroy();
    };
    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
    );
    await client.connect(
      new StdioClientTransport({
        command: 'node',
        args: [serverPath],
        env: { ...env, AIONUI_CDP_ACTIVE_PORT: String(bridge.port), AIONUI_CDP_BRIDGE_TOKEN: bridge.token },
        stderr: 'inherit',
      })
    );
    const call = async (args: Record<string, unknown>) => {
      const result = await client.callTool({ name: 'workbench', arguments: args });
      const content = result.content as Array<{ type: string; text: string }>;
      if (result.isError) throw new Error(content[0].text);
      return JSON.parse(content[0].text);
    };
    const tools = (await client.listTools()).tools.map((t) => t.name);
    const pages = { isError: false };
    const accounts = await call({ action: 'accounts' });
    const titles = [];
    for (const accountId of ids)
      titles.push(
        await call({
          action: 'browser',
          accountId,
          method: 'Runtime.evaluate',
          params: { expression: 'document.title', returnByValue: true },
        })
      );
    const replCall = async (code: string) => {
      const result = await client.callTool({ name: 'browser_repl', arguments: { code } });
      if (result.isError) throw new Error(JSON.stringify(result));
      return JSON.stringify(result.content);
    };
    await replCall('var source = browser.page("second"); await source.locator("#grid").fill("second only");');
    const replValue = await replCall('await source.locator("#grid").inputValue()');
    if (!replValue.includes('second only')) throw new Error('REPL did not persist page binding or fill input');
    const primaryValue = await replCall('await browser.page("primary").locator("#grid").inputValue()');
    if (primaryValue.includes('second only')) throw new Error('REPL crossed account boundary');
    const snapshot = await replCall('await source.snapshot()');
    if (!snapshot.includes('textbox')) throw new Error('Missing compact accessibility snapshot');
    await replCall('await source.getByRole("textbox").fill("by role");');
    if (!(await replCall('await source.locator("#grid").inputValue()')).includes('by role'))
      throw new Error('Role locator failed');
    await replCall('await source.locator("#grid").press("Meta+A")');
    if (!(await replCall('await source.copySelection()')).includes('by role'))
      throw new Error('Account selection copy failed');
    await replCall(
      `await source.mouse.wheel(350,0,{x:80,y:90}); await source.waitForFunction("document.getElementById('scroller').scrollLeft > 0");`
    );
    let emptyCopyRejected = false;
    try {
      await replCall(
        'await browser.page("primary").locator("#grid").click(); await browser.page("primary").copySelection()'
      );
    } catch (error) {
      emptyCopyRejected = String(error).includes('Copy returned no text');
    }
    if (!emptyCopyRejected) throw new Error('Empty clipboard was treated as verified table contents');
    const runId = 'integration';
    // Approval clicks focus the host composer between focusing a guest input and typing.
    await win.webContents.executeJavaScript(
      `document.body.insertAdjacentHTML('afterbegin', '<textarea id="composer"></textarea>')`
    );
    await call({
      action: 'browser',
      accountId: 'feishu',
      method: 'Runtime.evaluate',
      params: { expression: 'document.querySelector("textarea").focus()' },
    });
    win.webContents.focus();
    await win.webContents.executeJavaScript('document.querySelector("#composer").focus()');
    await call({ action: 'browser', accountId: 'feishu', method: 'Input.insertText', params: { text: '采集键' } });
    const fieldInput = await call({
      action: 'browser',
      accountId: 'feishu',
      method: 'Runtime.evaluate',
      params: { expression: 'document.querySelector("textarea").value', returnByValue: true },
    });
    const composerInput = await win.webContents.executeJavaScript('document.querySelector("#composer").value');
    if (fieldInput.result.value !== '采集键' || composerInput !== '')
      throw new Error(
        `Input escaped account browser: field=${JSON.stringify(fieldInput.result.value)} composer=${JSON.stringify(composerInput)}`
      );
    await call({
      action: 'browser',
      accountId: 'feishu',
      method: 'Runtime.evaluate',
      params: { expression: 'document.querySelector("textarea").value = ""' },
    });
    const tableUrl = 'https://test.feishu.cn/base/test?table=tbl1';
    await call({ action: 'start', runId, accountIds: ['primary', 'second'], tableUrl, layout: 'legacy' });
    const comments = [
      {
        noteId: 'note1',
        commentId: 'c1',
        author: 'fixture',
        text: 'shared comment',
        noteUrl: 'https://www.xiaohongshu.com/explore/note1',
      },
    ];
    for (const accountId of ['primary', 'second']) await call({ action: 'collect', runId, accountId, comments });
    await call({ action: 'existing', runId, tableUrl, present: [] });
    await call({ action: 'stop', runId });
    const waitForRunState = async (stopped: boolean) => {
      const deadline = Date.now() + 5000;
      do {
        if ((await call({ action: 'status', runId })).stopped === stopped) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
      throw new Error(`Archive run did not reach stopped=${stopped}`);
    };
    const controller = new AbortController();
    const pending = client
      .callTool(
        {
          name: 'browser_repl',
          arguments: {
            code: `await sync({ action: 'resume', runId: ${JSON.stringify(runId)} }); await new Promise(() => {})`,
          },
        },
        undefined,
        { signal: controller.signal }
      )
      .catch(() => undefined);
    // The pending invocation owns this run only after it has dispatched archive work.
    await waitForRunState(false);
    await call({ action: 'start', runId: 'other-run', accountIds: ['second'], tableUrl, layout: 'legacy' });
    controller.abort();
    await pending;
    await waitForRunState(true);
    const otherRun = await call({ action: 'status', runId: 'other-run' });
    const cancellationIsolated = !otherRun.stopped;
    let stopped = false;
    try {
      await call({ action: 'paste', runId });
    } catch {
      stopped = true;
    }
    await call({ action: 'resume', runId });
    await call({
      action: 'browser',
      accountId: 'feishu',
      method: 'Runtime.evaluate',
      params: { expression: 'document.querySelector("textarea").focus()' },
    });
    const batch = await call({ action: 'paste', runId });
    let pasted = '';
    for (let attempt = 0; attempt < 30; attempt++) {
      const readback = await call({
        action: 'browser',
        accountId: 'feishu',
        method: 'Runtime.evaluate',
        params: { expression: 'document.querySelector("textarea").value', returnByValue: true },
      });
      pasted = readback.result.value;
      if (pasted) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    let blindRetryBlocked = false;
    try {
      await call({ action: 'paste', runId });
    } catch {
      blindRetryBlocked = true;
    }
    if (!pasted.includes(batch.rows[0].key)) throw new Error('Real clipboard paste was not observed');
    const final = await call({
      action: 'reconcile',
      runId,
      batchId: batch.id,
      present: [batch.rows[0].key],
      absent: [],
    });
    await writeFile(
      output,
      JSON.stringify({
        tools,
        pages,
        accounts,
        titles,
        cancellationIsolated,
        stopped,
        blindRetryBlocked,
        pasted,
        final,
      })
    );
    await client.close();
    await bridge.close();
    win.destroy();
    app.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    await closeOnFailure();
    app.exit(1);
  });
