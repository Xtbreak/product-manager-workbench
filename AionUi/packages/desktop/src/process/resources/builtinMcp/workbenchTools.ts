import type { Tool } from '@modelcontextprotocol/sdk/types.js';
/** Workflow contract supplied to the agent alongside the existing browser tools. */
export const workbenchTool: Tool = {
  name: 'workbench',
  description: `Operate the workbench's independent logged-in account browsers and durably sync Xiaohongshu comments into the CENTER Feishu browser. Always start with action=accounts. Each browser command requires accountId; never infer identity from the visible tab or matching URLs. browser supports Runtime.evaluate (JavaScript), Accessibility.getFullAXTree, Page.navigate, Input mouse/key/text, and screenshots. Use these explicit-account commands when URLs are identical. Do not create external Chrome windows.

LEFT-CHAT COMMENT TASKS (XIAOHONGSHU + DOUYIN): Use action="reply-sync" with a nested request. First request={action:"status"} to inspect the existing reply table, bound works, sendMode, canCancelSend and uncertain results. Reuse existing setup and bindings; never create replacement tables or change logins. request={action:"setup",sourceUrl:"EXACT_FEISHU_URL"} provisions the separate reply table only when needed. request={action:"configure"} arranges the existing table for toolbar sending with six visible columns: User, Time, Comment, Original comment, My reply, and Status. It removes the per-row Send control and disables its legacy workflow while preserving records and technical fields. Use it only when the user requests that setup. Existing presentation alone does not mean toolbar sending is ready: sendMode must be "toolbar".
MANUAL REPLIES ONLY: There is no automatic sending. The user can (1) fill My reply in Feishu, then explicitly click Send comments in the Workbench toolbar to send all eligible drafts in that batch; or (2) click View comment in Original comment inside Workbench, open the matching account and reply directly on the platform. There is no per-row Send click or ready checkbox. Exact comment location requires Workbench; outside it the link opens only the work. A later explicit collection replaces the Feishu draft with the actual verified platform reply and marks Replied, excluding that row from later sending. Historical owner-comment rows remain preserved as Own comment and are never customer reply targets. Do not compose or publish replies without the user's explicit authorization.
request={action:"bind",accountId:"EXACT_ACCOUNT_ID"} binds the own work currently open in that browser and archives observed comments. request={action:"collect"} and request={action:"sync"} both collect comments and reconcile observed replies without publishing comments. request={action:"send-pending"} is the sole publishing action: it requires sendMode="toolbar" and explicit authorization to send. It reads the current trusted rows once, snapshots non-empty drafts for eligible unanswered customer comments, and processes that snapshot sequentially. Drafts entered or changed afterward require another explicit send; do not substitute new text into the current batch. Already sent/replied rows, owner comments and unresolved sends are excluded. Repeated clicks cannot overlap a running batch. request={action:"cancel"} cancels the selected current send and stops remaining selections when canCancelSend=true; unsent drafts are preserved. Cancellation after dispatch may still require readback. request={action:"reconcile"} checks uncertain outcomes and retries result writeback without reposting. A pending result writeback blocks resending. Never treat a different observed manual reply as proof that an uncertain send succeeded.
Never request automatic mode or enable legacy processing. Inspection or collection does not authorize send-pending. Filling a draft does not send it. Only verified platform results become Sent or Replied. Preserve drafts when arranging an old table; do not activate its row workflow. One row targets one exact comment; preserve direct-parent multi-round routing. Never bypass this workflow with raw browser posting. Report partial collection, verification requests and unresolved outcomes honestly. Platform verification requires the user. Stopping a chat tool cancels that tool operation; use cancel for the selected current send.
Reply-task responses preserve status fields and add execution.startedAt/finishedAt (ISO timestamps) and execution.durationMs (monotonic elapsed milliseconds for that bridge call). Report those measured values, not estimates. This duration excludes model thinking and time before the tool starts; distinguish it from end-to-end chat elapsed time. After errors/cancellation inspect status before another operation; never blindly retry an uncertain send.

LOCAL FEISHU CLI (PREFERRED): After accounts, call action=feishu-status. When ready, use the user's local CLI credentials. After start + collect, call action=cli-sync with runId instead of browser paste. It resolves the wiki URL, checks the exact three text fields, reads existing rows, deduplicates, batch-writes up to 50 comments, reads back, and commits confirmations to the same local journal. Repeat only when state=continue. Do not configure headers or click cells when CLI is available. On authorization errors ask the user to use Settings > Feishu authorization. On uncertain writes inspect status and reconcile; never blindly retry or switch to paste. Existing legacy runs keep the browser path. CLI writes preserve exact text and time; no TSV sanitization applies.

COMMENT TO TABLE WORKFLOW (BROWSER FALLBACK ONLY when CLI is unavailable):
1. Inspect accounts and logged-in pages. If login/authorization is needed, ask the user; never report simulated data as real.
2. Open ONE authorized Feishu multi-dimensional table in accountId=feishu. New runs default to layout=compact: exactly THREE TEXT columns in order: 用户, 时间, 评论. Keep IDs, provenance and deduplication keys in the local journal, NEVER add them as visible columns. Reuse a matching table. If the user authorized a new table, create it once and set these three headers; do not repeatedly create/reconfigure tables. Never delete populated columns without explicit user authorization. Old runs retain layout=legacy and seven columns; resume their original schema or use a separate three-column table for a new run. Preserve existing tables/data. Start with stable runId, the source accountIds, exact tableUrl including table= ID. Reuse this runId on retry.
3. Read actual comment DOM/network results separately in each source browser. Collect real noteId/commentId/author/time/text/noteUrl via action=collect, accountId, comments. IDs must be observed, never invented. time is required for compact runs: preserve the displayed time (including relative text); use 未显示 only when the source genuinely has no visible time. Expand/scroll as needed, report incomplete coverage honestly. All sources must be collected before writing. Dedupe is global per noteId+commentId with merged account provenance.
4. Inspect destination headers and existing rows BEFORE writing. For compact tables match the complete 用户/时间/评论 tuple to the collected journal rows; map observed matches back to their LOCAL keys. Match multiplicities, never collapse distinct comments with identical text. If matching is ambiguous, stop and explain. For legacy tables match the 采集键 column. Use action=existing to record already-present keys after checking the exact destination (also required when empty). Never paste duplicates across runs. Focus the first empty row's FIRST column in the CENTER browser with explicit-account commands. Check columns and destination before paste.
5. action=paste with runId saves an uncertain batch BEFORE dispatching a real clipboard paste to the Feishu browser. This overwrites the system clipboard. It does NOT prove the table accepted the rows. Paste the full returned batch in ONE clipboard operation (up to 50 rows), never one cell/comment at a time. Select and copy the entire inserted rectangle ONCE with copySelection to read all three columns back together. Account for TSV sanitization (tabs/newlines become spaces and formula-like text is escaped). Compare full tuples and counts against batch.rows, mapping each to its local key; keys are NOT visible in compact tables. For legacy tables read the key column. Then action=reconcile with batchId, present keys, and confirmed absent keys covering the ENTIRE batch. Never mark an unobserved row written. Pending uncertain batches block further paste. status supplies pending keys after restart. If unable to verify, stop and explain; do not blindly retry.
6. Continue batches until no unwritten rows and no pending batch. Summarize actual source counts, deduped/written counts and limits.
STOP/RETRY: action=stop prevents new paste/collect; resume re-enables the same run without erasing pending state. After interruption, status first; reconcile any pending batch BEFORE retry. Cancellation does not undo a paste already dispatched. Never schedule delayed scripts, timer loops or autonomous future writes in pages. No actions after user stops.`,
  inputSchema: {
    type: 'object',
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: [
          'accounts',
          'reply-sync',
          'feishu-status',
          'cli-sync',
          'browser',
          'start',
          'collect',
          'existing',
          'paste',
          'reconcile',
          'status',
          'stop',
          'resume',
        ],
      },
      request: {
        type: 'object',
        description:
          'Required for reply-sync; collects comments or explicitly sends the current Feishu draft batch through the toolbar workflow.',
        required: ['action'],
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'setup', 'configure', 'bind', 'collect', 'sync', 'reconcile', 'cancel', 'send-pending'],
          },
          sourceUrl: { type: 'string', description: 'Existing Feishu table URL, required only for setup.' },
          accountId: { type: 'string', description: 'Exact existing account ID, required only for bind.' },
        },
      },
      accountId: { type: 'string' },
      accountIds: { type: 'array', items: { type: 'string' } },
      runId: { type: 'string' },
      tableUrl: { type: 'string' },
      layout: {
        type: 'string',
        enum: ['compact', 'legacy'],
        description: 'New runs default to compact: 用户, 时间, 评论. Existing runs retain their layout.',
      },
      method: {
        type: 'string',
        enum: [
          'Runtime.evaluate',
          'DOM.resolveNode',
          'Runtime.callFunctionOn',
          'Runtime.releaseObject',
          'Accessibility.getFullAXTree',
          'Page.navigate',
          'Input.dispatchMouseEvent',
          'Input.dispatchKeyEvent',
          'Input.insertText',
          'Page.captureScreenshot',
        ],
      },
      params: { type: 'object', additionalProperties: true },
      comments: {
        type: 'array',
        items: {
          type: 'object',
          required: ['noteId', 'commentId', 'author', 'text', 'noteUrl'],
          properties: {
            noteId: { type: 'string' },
            commentId: { type: 'string' },
            author: { type: 'string' },
            time: {
              type: 'string',
              description: 'Required for compact runs: observed displayed comment time, or 未显示 if absent on source.',
            },
            text: { type: 'string' },
            noteUrl: { type: 'string' },
          },
        },
      },
      batchId: { type: 'string' },
      present: { type: 'array', items: { type: 'string' } },
      absent: { type: 'array', items: { type: 'string' } },
    },
  },
};

/** Persistent code execution for the workbench's own AI. */
export const browserReplTool: Tool = {
  name: 'browser_repl',
  description: `Preferred browser operation tool. Execute JavaScript in a persistent REPL with top-level await. Variables survive successful calls; use var for redeclaration. This is a narrow Playwright-style API, not full Playwright. Operate ONLY the existing workbench account browsers; no external browser or login changes.
Start: console.log(await browser.accounts()); var p = browser.page("EXACT_ACCOUNT_ID"); console.log(await p.snapshot());
Page API: await p.goto(url); await p.url(); await p.snapshot(); await p.locator("CSS selector").click()/fill(text)/press("Enter")/textContent()/inputValue()/scroll(x,y); await p.getByRole("button", {name:"Exact accessible name"}).click(); await p.getByText("Exact text").click(); refs from snapshot work as p.locator("@123"). Refresh after navigation. Locators require exactly one match. await p.evaluate(() => document.title) or p.evaluate(function,arg) returns JSON values from synchronous DOM extraction only; async/await, timers and network calls in page code are unsupported. Orchestrate waits in REPL. Read real DOM data with this. await p.waitForFunction("document.readyState === 'complete'"); await p.scroll(0,600). await p.copySelection() copies the currently selected browser cells/text and returns text/TSV, replacing the system clipboard; use to read back selected Feishu rows, never assume screenshot means paste succeeded. For canvas only: await p.screenshot() attaches an image; await p.mouse.click(x,y); await p.mouse.wheel(deltaX,deltaY,{x,y}) dispatches REAL wheel input over a canvas; locator.scroll(deltaX,deltaY) uses wheel over its center. Use this for Feishu horizontal scrolling instead of repeated scrollbar clicks. await p.keyboard.press("Meta+A"); await p.keyboard.type(text). Bundle related awaited actions into one call, then inspect results. Log only needed data; output is bounded.
await sync({action:"...", ...}) uses the SAME durable workflow as workbench tool: accounts/start/collect/existing/paste/reconcile/status/stop/resume. New runs use workbench's THREE-column contract: 用户, 时间, 评论. Collect observed time with each comment. Internal IDs stay in the local journal; do not add visible key columns. Legacy runs retain seven columns. Reuse an existing correctly structured table; configure headers only once. Batch all comments (up to 50) in one paste and copy the whole inserted range once for read-back; avoid one-cell-at-a-time editing and screenshot loops. Prefer sync({action:"feishu-status"}) then sync({action:"cli-sync",runId}) after start/collect for three-column tables: this uses local CLI auth and automatically checks headers, deduplicates, writes a batch and verifies it. Repeat only on state=continue. Never paste after an uncertain CLI result. Browser fallback data-row writes must use sync({action:"paste",runId}) after collection/existing checks; never bypass the journal by typing/evaluating comment rows. After paste compare all three displayed values and row counts to batch.rows, map them to local keys and reconcile. Stop on ambiguous identical tuples; never guess confirmations. Source data must be genuinely observed in each account.
For left-chat Xiaohongshu/Douyin comment tasks use await sync({action:"reply-sync",request:{action:"status"}}), then the SAME manual-only nested request contract as workbench: setup/configure/bind/collect/sync/reconcile/cancel/send-pending. collect and sync only collect comments and backfill verified platform replies; they never publish. The user either fills My reply in Feishu and explicitly clicks Send comments in the Workbench toolbar, or opens View comment inside Workbench and replies on the platform using the matching account. There is no per-row Send or ready checkbox. Exact location requires Workbench; external links open only the work. A later explicit collection replaces the draft with the actual verified platform reply and marks Replied. Owner comments are never new customer targets. send-pending is the sole publishing action and requires sendMode="toolbar" plus explicit send authorization. It snapshots all eligible non-empty drafts for unanswered customer comments once and sends them sequentially; later additions or text changes need another explicit send. Already sent/replied rows, owner comments and unresolved sends are excluded. An old presentation must be arranged with configure before toolbar sending: preserve records, hide the old Send column and disable its workflow. No background collection or sending runs. Never enable legacy processing or request automatic mode. cancel stops the selected current send and remaining batch when canCancelSend=true, preserving unsent drafts. Repeated send requests cannot overlap. Preserve existing tables/bindings/logins, drafts, exact targets and explicit authorization. Inspection never authorizes send-pending. Do not post directly without authorization. Successful replies return status plus execution.startedAt/finishedAt/durationMs measured for the bridge call; log this object and report actual counts/partial coverage. Stop cancels this tool call; cancel targets the selected current send. After interruption inspect reply status and reconcile unknown outcomes without reposting. Pending writeback blocks resending, and a different manual reply does not confirm an uncertain send.
STOP/RETRY: cancellation/timeout kills this REPL and clears variables, preserving logins and durable sync journal. Retry: status first, inspect any uncertain batch, reconcile before more writes; resume same runId. Never use detached promises, timers, page-side delayed writes, imports, filesystem, network clients or process APIs. Await all browser operations. Each page is bound to an explicit accountId. Use snapshot/locators first, screenshots only when necessary.`,
  inputSchema: {
    type: 'object',
    required: ['code'],
    properties: {
      code: { type: 'string', maxLength: 100000 },
      timeoutMs: { type: 'number', minimum: 100, maximum: 120000 },
    },
  },
};
