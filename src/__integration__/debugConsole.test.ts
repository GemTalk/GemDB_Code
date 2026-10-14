import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  __debugFactories,
  __debugStarts,
  DebugAdapterInlineImplementation,
  NotebookCellKind,
  SourceBreakpoint,
  debug,
  workspace,
} from '../__mocks__/vscode';
import { PauseDebugAdapter, registerBreakpointDebugger } from '../debugger';
import { fileOwner } from '../fileOwner';
import { stageGrail } from '../grail';
import { abortQuery, needsCommitQuery } from '../pauseVariables';
import { isRunning, startNetldi, startStone, stopNetldi, stopStone } from '../processes';
import { PyResult, runPython, runPythonFile } from '../pythonQueries';
import {
  SessionOwner,
  closeSessionFor,
  executeAsync,
  logoutAll,
  sessionForIfOpen,
} from '../session';
import { createDatabaseWithPython, Fixture, haveTestExtent, makeFixture } from './fixture';

/**
 * The Debug Console and the Watch pane against a real database, through the
 * adapter VS Code would talk to: a cell pauses at breakpoint(), the debugger
 * opens on it as it does in the editor, and the test types into the console
 * by sending `evaluate` requests.
 *
 * The bar is debugpy's console: whatever the paused line could have said, the
 * console can say, against the same names, and it reads back the way Python
 * would — an error as a Jupyter traceback.
 */

const ext = process.cwd();
const haveExtent = haveTestExtent();

/** A notebook of its own per test, so no test sees another's globals. */
const notebook = (name: string): SessionOwner => ({
  key: `file:///${name}.ipynb`,
  kind: 'notebook',
  label: `${name}.ipynb`,
});

/** A module the notebooks import, with names of its own and a line to put a red dot on. */
const DCMOD = [
  'MODULE_ONLY = "mod"',
  'shared = "module"',
  '',
  'def in_module(arg):',
  '    breakpoint()',
  '    return arg',
  '',
  'def fail():',
  '    return {}["missing"]',
  '',
  'def dotted():',
  '    x = 41',
  '    return x + 1',
].join('\n');

/** The line of `x = 41` in DCMOD, 1-based. */
const DOTTED_LINE = 12;

let fixture: Fixture | undefined;

beforeAll(async () => {
  if (!haveExtent) return;
  fixture = makeFixture();
  if (!fixture) return;
  fs.writeFileSync(path.join(fixture.root, 'dcmod.py'), DCMOD);
  createDatabaseWithPython(fixture);
  stageGrail(ext);
  await startStone();
  await startNetldi();
});

afterAll(async () => {
  if (!fixture) return;
  logoutAll();
  try {
    await stopNetldi();
  } finally {
    if (isRunning()) await stopStone(true);
    fixture.remove();
  }
});

/** See database.test.ts — skipIf is evaluated during collection. */
function canMakeFixture(): boolean {
  const probe = makeFixture();
  if (!probe) return false;
  probe.remove();
  return true;
}

/** The cell lines that make `dcmod` importable from the fixture's root. */
const importDcmod = (): string =>
  `import sys\nsys.path.insert(0, ${JSON.stringify(fixture!.root)})\nimport dcmod`;

// ---------------------------------------------------------------------------
// Talking to the adapter the way VS Code does.
// ---------------------------------------------------------------------------

type Message = Record<string, unknown> & {
  type: string;
  command?: string;
  event?: string;
  request_seq?: number;
  success?: boolean;
  message?: string;
  body?: Record<string, unknown>;
};

/** What one console line or watch came back with. */
interface Evaluated {
  ok: boolean;
  /** The value as shown; '' for None or a statement. */
  result: string;
  type?: string;
  /** Opens the result like a Variables row; 0 for a leaf. */
  ref: number;
  indexed?: number;
  /** The failure's text: a traceback, or why the line was stopped. */
  message: string;
  /** Lines of `message`. */
  lines: string[];
  /** What the line printed, from `output` events sent before the answer. */
  printed: string;
  categories: string[];
  /** Whether the adapter told VS Code to read the variables again. */
  invalidated: boolean;
  millis: number;
}

class Dap {
  readonly sent: Message[] = [];
  private seq = 1;
  private readonly waiting = new Map<number, (m: Message) => void>();

  constructor(private readonly adapter: InstanceType<typeof PauseDebugAdapter>) {
    adapter.onDidSendMessage((raw) => {
      const m = raw as Message;
      this.sent.push(m);
      if (m.type === 'response' && m.request_seq !== undefined) {
        this.waiting.get(m.request_seq)?.(m);
        this.waiting.delete(m.request_seq);
      }
    });
  }

  /** Send a request; its seq at once, its response when it comes. */
  start(
    command: string,
    args: Record<string, unknown> = {},
  ): { seq: number; done: Promise<Message> } {
    const seq = this.seq++;
    const done = new Promise<Message>((resolve) => this.waiting.set(seq, resolve));
    this.adapter.handleMessage({ seq, type: 'request', command, arguments: args });
    return { seq, done };
  }

  request(command: string, args: Record<string, unknown> = {}): Promise<Message> {
    return this.start(command, args).done;
  }

  /** Type `expression` into the console (or add it as a watch) and wait for the answer. */
  async evaluate(
    expression: string,
    { frameId, context = 'repl' }: { frameId?: number; context?: string } = {},
  ): Promise<Evaluated> {
    const from = this.sent.length;
    const began = Date.now();
    const response = await this.request('evaluate', {
      expression,
      context,
      ...(frameId === undefined ? {} : { frameId }),
    });
    return this.read(response, from, began);
  }

  /** Make an Evaluated of a response, from what was sent since `from`. */
  read(response: Message, from: number, began: number): Evaluated {
    const millis = Date.now() - began;
    const upToAnswer = this.sent.slice(from, this.sent.indexOf(response));
    const outputs = upToAnswer.filter((m) => m.event === 'output');
    const body = response.body ?? {};
    const message = response.success ? '' : String(response.message ?? '');
    return {
      ok: response.success === true,
      result: String(body.result ?? ''),
      ...(body.type === undefined ? {} : { type: String(body.type) }),
      ref: Number(body.variablesReference ?? 0),
      ...(body.indexedVariables === undefined ? {} : { indexed: Number(body.indexedVariables) }),
      message,
      lines: message.split('\n'),
      printed: outputs.map((m) => String(m.body?.output ?? '')).join(''),
      categories: outputs.map((m) => String(m.body?.category ?? '')),
      // Sent with the answer or just after it; read once the answer is in.
      invalidated: this.sent.slice(from).some((m) => m.event === 'invalidated'),
      millis,
    };
  }

  /** The value an expression gives in the console, failing the test if it raised. */
  async value(expression: string, frameId?: number): Promise<string> {
    const r = await this.evaluate(expression, { frameId });
    if (!r.ok) throw new Error(`${expression} failed:\n${r.message}`);
    return r.result;
  }

  /** The last line of the error an expression raises — `NameError: …` and the like. */
  async raises(expression: string, frameId?: number): Promise<string> {
    const r = await this.evaluate(expression, { frameId });
    if (r.ok) throw new Error(`${expression} answered ${r.result} instead of raising`);
    return r.lines.filter((l) => l.trim() !== '').pop() ?? '';
  }

  async frames(): Promise<Array<{ id: number; name: string }>> {
    const r = await this.request('stackTrace', { threadId: 1 });
    return (r.body?.stackFrames ?? []) as Array<{ id: number; name: string }>;
  }

  async children(
    ref: number,
  ): Promise<Array<{ name: string; value: string; variablesReference: number }>> {
    const r = await this.request('variables', { variablesReference: ref });
    return (r.body?.variables ?? []) as Array<{
      name: string;
      value: string;
      variablesReference: number;
    }>;
  }

  /** A frame's Locals rows. */
  async locals(
    frameId = 1,
  ): Promise<Array<{ name: string; value: string; variablesReference: number }>> {
    const r = await this.request('scopes', { frameId });
    const scopes = (r.body?.scopes ?? []) as Array<{ name: string; variablesReference: number }>;
    const locals = scopes.find((s) => s.name === 'Locals');
    if (!locals) throw new Error(`frame ${frameId} has no Locals`);
    return this.children(locals.variablesReference);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The adapter VS Code would get for debug session `index` of `__debugStarts`. */
function adapterFor(index: number): InstanceType<typeof PauseDebugAdapter> {
  const factory = __debugFactories.get('gemdb') as {
    createDebugAdapterDescriptor: (s: unknown) => DebugAdapterInlineImplementation;
  };
  return factory.createDebugAdapterDescriptor({ configuration: __debugStarts[index] })
    .implementation as InstanceType<typeof PauseDebugAdapter>;
}

/**
 * Run `run` with the debugger registered, and at its Nth pause open the
 * debugger, as VS Code does, and hand it to the Nth of `drivers`; then
 * Continue. Answers the run's result and how many debug sessions it opened.
 * A driver that fails still continues the run, so the run never strands.
 */
async function atPauses(
  run: () => Promise<PyResult>,
  ...drivers: Array<(dap: Dap) => Promise<void>>
): Promise<{ result: PyResult; sessions: number }> {
  const registration = registerBreakpointDebugger();
  const first = __debugStarts.length;
  let ended = false;
  const running = run().finally(() => (ended = true));
  let failure: unknown;
  try {
    for (let i = 0; i < drivers.length; i++) {
      while (__debugStarts.length <= first + i) {
        if (ended) throw new Error(`the run ended before pause ${i + 1}`);
        await sleep(20);
      }
      const dap = new Dap(adapterFor(first + i));
      await dap.request('initialize', { adapterID: 'gemdb', supportsInvalidatedEvent: true });
      await dap.request('launch', {
        gemdbPause: (__debugStarts[first + i] as { gemdbPause: string }).gemdbPause,
      });
      await dap.request('configurationDone');
      try {
        await drivers[i](dap);
      } catch (e) {
        failure ??= e;
      } finally {
        await dap.request('continue', { threadId: 1 });
      }
    }
    const result = await running;
    if (failure) throw failure;
    return { result, sessions: __debugStarts.length - first };
  } finally {
    registration.dispose();
  }
}

/** Run `source` in notebook `nb` with the debugger open at each pause. */
const inCell = (
  nb: SessionOwner,
  source: string,
  ...drivers: Array<(dap: Dap) => Promise<void>>
): Promise<{ result: PyResult; sessions: number }> =>
  atPauses(() => runPython(source, nb), ...drivers);

/**
 * Put notebook `nb` in the editor with these code cells, run in order (so the
 * second reads `Cell [2]`), the way VS Code holds an open notebook. Answers
 * how to close it.
 */
function showNotebook(nb: SessionOwner, cells: string[]): () => void {
  const doc = {
    uri: { toString: () => nb.key },
    getCells: () =>
      cells.map((text, index) => ({
        index,
        kind: NotebookCellKind.Code,
        document: { uri: { toString: () => `${nb.key}#cell${index}` }, getText: () => text },
        executionSummary: { executionOrder: index + 1 },
      })),
  };
  workspace.notebookDocuments.push(doc);
  return () => {
    workspace.notebookDocuments.splice(workspace.notebookDocuments.indexOf(doc), 1);
  };
}

/** A cell that pauses once, in a function with no locals. */
const PAUSE_ONCE = 'def go():\n    breakpoint()\ngo()';

/** Text in an error that only GemDB's own machinery could have put there. */
const MACHINERY =
  /ModuleAst|SymbolDictionary|___gemdb|evaluateSource|GsProcess|AbstractException|SessionTemps/;

describe.skipIf(!haveExtent || !canMakeFixture())('the Debug Console at a pause', () => {
  it('answers an expression with its repr and type, and a result that opens like a Variables row', async () => {
    const nb = notebook('dc-values');
    const seen: Record<string, Evaluated> = {};
    let kids: string[] = [];
    let localRow = '';
    let pageOfBig: string[] = [];

    await inCell(
      nb,
      [
        'class P:',
        '    def __init__(self, name):',
        '        self.name = name',
        '        self.tags = {"a", "b"}',
        '    def __repr__(self):',
        '        return f"P({self.name!r})"',
        'def go(p):',
        '    breakpoint()',
        '    return p.name',
        'go(P("ann"))',
      ].join('\n'),
      async (dap) => {
        seen.p = await dap.evaluate('p');
        kids = (await dap.children(seen.p.ref)).map((v) => v.name).sort();
        seen.watch = await dap.evaluate('p', { context: 'watch' });
        localRow = (await dap.locals()).find((v) => v.name === 'p')!.value;
        seen.none = await dap.evaluate('None');
        seen.big = await dap.evaluate('list(range(1000))');
        pageOfBig = (
          (
            await dap.request('variables', {
              variablesReference: seen.big.ref,
              start: 998,
              count: 2,
            })
          ).body?.variables as Array<{ value: string }>
        ).map((v) => v.value);
      },
    );
    closeSessionFor(nb.key);

    // The console prints the repr, as debugpy and PyCharm do: no type badge.
    expect(seen.p).toMatchObject({ ok: true, result: "P('ann')", type: 'P' });
    expect(seen.p.ref).toBeGreaterThan(0);
    // Opened as a Variables row is: its data, with its dunders folded into a group.
    expect(kids).toEqual(['name', 'special variables', 'tags']);
    // A watch is a row, so it reads as the Variables row for the same object does.
    expect(seen.watch).toMatchObject({ ok: true, result: localRow });
    expect(seen.none).toMatchObject({ ok: true, result: '', ref: 0 });
    expect(seen.big.indexed).toBe(1000);
    expect(pageOfBig).toEqual(['{int} 998', '{int} 999']);
  });

  it('keeps names typed in the console for the rest of the pause, and only that long', async () => {
    const nb = notebook('dc-names');
    const first: Record<string, string> = {};
    let afterResume = '';

    await inCell(
      nb,
      [
        'def go():',
        '    n = 1',
        '    breakpoint()',
        '    breakpoint()',
        '    return n',
        'go()',
      ].join('\n'),
      async (dap) => {
        first.assign = await dap.value('y = 5');
        first.y = await dap.value('y + 1');
        first.import = await dap.value('import json');
        first.json = await dap.value('json.dumps([n, y])');
        first.def = await dap.value('def twice(v):\n    return v * 2');
        first.call = await dap.value('twice(y)');
        first.block = await dap.value('total = 0\nfor i in range(4):\n    total += i\ntotal');
        first.rebind = await dap.value('n = 99');
        first.n = await dap.value('n');
      },
      async (dap) => {
        afterResume = await dap.raises('y');
      },
    );
    closeSessionFor(nb.key);

    expect(first).toEqual({
      assign: '',
      y: '6',
      import: '',
      json: "'[1, 5]'",
      def: '',
      call: '10',
      block: '6',
      rebind: '',
      n: '99',
    });
    expect(afterResume).toBe("NameError: name 'y' is not defined");
  });

  it.todo(
    'writes a local rebound in the console (n = 99) back into the paused frame, as debugpy does — not decided yet',
  );

  it('sends what a line prints to the console as stdout, not to the cell, even when the line then fails', async () => {
    const nb = notebook('dc-print');
    const cellPrinted: string[] = [];
    const seen: Record<string, Evaluated> = {};

    await atPauses(
      () =>
        runPython('def go(p):\n    breakpoint()\ngo("x")', nb, (chunk) => cellPrinted.push(chunk)),
      async (dap) => {
        seen.print = await dap.evaluate('print("hello", p)');
        seen.thenFail = await dap.evaluate('print("first")\n1/0');
      },
    );
    closeSessionFor(nb.key);

    expect(seen.print).toMatchObject({ ok: true, result: '', printed: 'hello x\n' });
    expect(seen.print.categories).toEqual(['stdout']);
    expect(seen.thenFail).toMatchObject({ ok: false, printed: 'first\n' });
    expect(cellPrinted.join('')).toBe('');
  });

  it('finds names as the paused line would: locals, closed-over names, the notebook, its imports, builtins', async () => {
    const nb = notebook('dc-scope');
    await runPython('import math', nb);
    const inner: Record<string, string> = {};
    const outer: Record<string, string> = {};
    let top = '';
    let frameNames: string[] = [];

    await inCell(
      nb,
      [
        'nb_global = 10',
        'def outer():',
        '    captured = "c"',
        '    def inner(k):',
        '        seen = captured',
        '        breakpoint()',
        '        return seen',
        '    return inner(3)',
        'outer()',
      ].join('\n'),
      async (dap) => {
        frameNames = (await dap.frames()).map((f) => f.name);
        inner.local = await dap.value('k');
        inner.closedOver = await dap.value('captured');
        inner.global = await dap.value('nb_global');
        inner.earlierImport = await dap.value('math.pi');
        inner.builtin = await dap.value('len([k, k])');
        inner.isinstance = await dap.value('isinstance(k, int)');
        inner.comprehension = await dap.value('[k for _ in range(2)]');
        inner.lambda = await dap.value('(lambda: k + 1)()');
        inner.generator = await dap.value('sum(k for _ in range(2))');
        outer.local = await dap.value('captured', 2);
        outer.notHere = await dap.raises('k', 2);
        top = await dap.value('nb_global', 3);
      },
    );
    closeSessionFor(nb.key);

    expect(frameNames[0]).toMatch(/inner$/);
    expect(frameNames.slice(1, 3)).toEqual(['outer', '<module>']);
    expect(inner).toEqual({
      local: '3',
      closedOver: "'c'",
      global: '10',
      earlierImport: '3.141592653589793',
      builtin: '2',
      isinstance: 'True',
      // One scope, not locals over globals as two dicts: debugpy's comprehension trap.
      comprehension: '[3, 3]',
      lambda: '4',
      generator: '6',
    });
    // Each frame its own: the selected frame decides.
    expect(outer).toEqual({ local: "'c'", notHere: "NameError: name 'k' is not defined" });
    expect(top).toBe('10');
  });

  const ACCOUNT = [
    'class Account:',
    '    rate = 2',
    '    def __init__(self):',
    '        self.balance = 7',
    '    def show(self):',
    '        breakpoint()',
    '    @classmethod',
    '    def make(cls):',
    '        breakpoint()',
    '        return cls()',
  ].join('\n');

  it('binds self in a method', async () => {
    const nb = notebook('dc-self');
    const seen: Record<string, string> = {};

    await inCell(nb, `${ACCOUNT}\nAccount().show()`, async (dap) => {
      seen.balance = await dap.value('self.balance');
      seen.both = await dap.value('self.rate * self.balance');
    });
    closeSessionFor(nb.key);

    expect(seen).toEqual({ balance: '7', both: '14' });
  });

  // Fails today, in Grail rather than here: a classmethod's frame carries no
  // `cls` in its locals (Grail's PyFrame ___receiverNameForMethod___ answers
  // nil for it), so the Locals pane shows none and the console has none to
  // copy. When this starts passing, drop `.fails`.
  it.fails('binds cls in a classmethod', async () => {
    const nb = notebook('dc-cls');
    const seen: Record<string, string> = {};

    await inCell(nb, `${ACCOUNT}\nAccount.make()`, async (dap) => {
      seen.rate = await dap.value('cls.rate');
      seen.name = await dap.value('cls.__name__');
    });
    closeSessionFor(nb.key);

    expect(seen).toEqual({ rate: '2', name: "'Account'" });
  });

  it('gives a frame in an imported module that module’s globals, not the notebook’s', async () => {
    const nb = notebook('dc-module');
    await runPython(importDcmod(), nb);
    const inModule: Record<string, string> = {};
    const inCellFrame: Record<string, string> = {};

    await inCell(nb, 'shared = "notebook"\nnb_only = 1\ndcmod.in_module(5)', async (dap) => {
      inModule.own = await dap.value('MODULE_ONLY');
      inModule.shared = await dap.value('shared');
      inModule.arg = await dap.value('arg');
      inModule.notebookOnly = await dap.raises('nb_only');
      inCellFrame.shared = await dap.value('shared', 2);
      inCellFrame.notebookOnly = await dap.value('nb_only', 2);
    });
    closeSessionFor(nb.key);

    expect(inModule).toEqual({
      own: "'mod'",
      shared: "'module'",
      arg: '5',
      notebookOnly: "NameError: name 'nb_only' is not defined",
    });
    expect(inCellFrame).toEqual({ shared: "'notebook'", notebookOnly: '1' });
  });

  it('gives a .py run’s frames that run’s __main__ globals', async () => {
    const file = path.join(fixture!.root, 'dcjob.py');
    fs.writeFileSync(
      file,
      ['total = 10', 'def step(n):', '    breakpoint()', '    return n', 'step(3)'].join('\n'),
    );
    const owner = fileOwner(file);
    const seen: Record<string, string> = {};

    await atPauses(
      () => runPythonFile(file, owner, () => {}),
      async (dap) => {
        seen.sum = await dap.value('total + n');
        seen.name = await dap.value('__name__');
      },
    );
    closeSessionFor(owner.key);

    expect(seen).toEqual({ sum: '13', name: "'__main__'" });
  });

  it('shows an error as a Jupyter traceback: the console’s lines, then each frame it went through', async () => {
    const nb = notebook('dc-errors');
    const cells = [importDcmod(), 'def boom(d):\n    return 10 / d', PAUSE_ONCE];
    // Open, as it is in the editor: a cell's frame shows that cell's lines.
    const close = showNotebook(nb, cells);
    await runPython(cells[0], nb);
    await runPython(cells[1], nb);
    const seen: Record<string, Evaluated> = {};
    const last: Record<string, string> = {};
    let after = '';

    await inCell(nb, cells[2], async (dap) => {
      seen.here = await dap.evaluate('x = 1\n1/0');
      seen.called = await dap.evaluate('boom(0)');
      seen.module = await dap.evaluate('dcmod.fail()');
      last.name = await dap.raises('nope');
      seen.syntax = await dap.evaluate('1 +');
      after = await dap.value('6 * 7');
    }).finally(close);
    closeSessionFor(nb.key);

    // As a notebook cell's error reads in Jupyter:
    //   -----------------------------------------------------------------
    //   ZeroDivisionError                 Traceback (most recent call last)
    //   <where>, line 2
    //         1 x = 1
    //   ----> 2 1/0
    //
    //   ZeroDivisionError: division by zero
    const here = seen.here.lines;
    expect(seen.here.ok).toBe(false);
    expect(here[0]).toMatch(/^-{40,}$/);
    expect(here[1]).toMatch(/^ZeroDivisionError\s+Traceback \(most recent call last\)$/);
    expect(here.some((l) => /line 2\b/.test(l))).toBe(true);
    expect(here).toContainEqual(expect.stringMatching(/^\s+1 x = 1$/));
    expect(here).toContainEqual(expect.stringMatching(/^----> 2 1\/0$/));
    expect(here[here.length - 1]).toBe('ZeroDivisionError: division by zero');

    // A function the console called: its own frame, after the console's, with its line marked.
    const called = seen.called.lines;
    const consoleFrame = called.findIndex((l) => /^----> 1 boom\(0\)$/.test(l));
    const boomFrame = called.findIndex((l) => /^Cell \[2\], line 2, in boom$/.test(l));
    expect(consoleFrame).toBeGreaterThan(0);
    expect(boomFrame).toBeGreaterThan(consoleFrame);
    expect(called).toContainEqual(expect.stringMatching(/^----> 2\s+return 10 \/ d$/));
    expect(called[called.length - 1]).toBe('ZeroDivisionError: division by zero');

    // A frame in a .py module is named by its file.
    const mod = seen.module.lines;
    expect(mod.some((l) => l.includes('dcmod.py') && /\bin fail\b/.test(l))).toBe(true);
    expect(mod).toContainEqual(expect.stringMatching(/^----> 9\s+return \{\}\["missing"\]$/));
    expect(mod[mod.length - 1]).toBe("KeyError: 'missing'");

    expect(last.name).toBe("NameError: name 'nope' is not defined");
    // A SyntaxError shows the line it could not read, as Jupyter does.
    expect(seen.syntax.ok).toBe(false);
    expect(seen.syntax.lines).toContainEqual(expect.stringMatching(/^\s*1 \+$/));
    expect(seen.syntax.lines[seen.syntax.lines.length - 1]).toBe('SyntaxError: invalid syntax');

    // Nothing of GemDB's own evaluation shows through.
    for (const e of [seen.here, seen.called, seen.module, seen.syntax]) {
      expect(e.message).not.toMatch(MACHINERY);
    }
    // And an error costs nothing: the pause goes on answering.
    expect(after).toBe('42');
  });

  it('lets a console line run past the two seconds a Variables row gets, but not a watch', async () => {
    const nb = notebook('dc-time');
    const seen: Record<string, Evaluated> = {};

    await inCell(nb, PAUSE_ONCE, async (dap) => {
      seen.slow = await dap.evaluate('import time\ntime.sleep(3)\n"slept"');
      seen.watch = await dap.evaluate('__import__("time").sleep(10) or "slept"', {
        context: 'watch',
      });
      seen.after = await dap.evaluate('1 + 1');
    });
    closeSessionFor(nb.key);

    expect(seen.slow).toMatchObject({ ok: true, result: "'slept'" });
    expect(seen.slow.millis).toBeGreaterThanOrEqual(3_000);
    expect(seen.watch.ok).toBe(false);
    expect(seen.watch.message).toMatch(/too long/i);
    expect(seen.watch.millis).toBeLessThan(8_000);
    expect(seen.after).toMatchObject({ ok: true, result: '2' });
  });

  it('stops a runaway line on cancel, and the pause goes on answering', async () => {
    const nb = notebook('dc-cancel');
    let stopped: Evaluated | undefined;
    let after = '';

    const { result } = await inCell(nb, `${PAUSE_ONCE}\n"finished"`, async (dap) => {
      const from = dap.sent.length;
      const began = Date.now();
      const spin = dap.start('evaluate', { expression: 'while True:\n    pass', context: 'repl' });
      await sleep(500);
      await dap.request('cancel', { requestId: spin.seq });
      stopped = dap.read(await spin.done, from, began);
      after = await dap.value('2 + 2');
    });
    closeSessionFor(nb.key);

    expect(stopped).toMatchObject({ ok: false });
    expect(stopped!.message).toMatch(/interrupted|cancelled/i);
    expect(stopped!.message).not.toMatch(/Traceback/);
    expect(stopped!.millis).toBeLessThan(10_000);
    expect(after).toBe('4');
    expect(result.value).toBe("'finished'");
  });

  it('runs straight past breakpoint() and red dots in code the console calls', async () => {
    const nb = notebook('dc-dots');
    await runPython(importDcmod(), nb);
    const seen: Record<string, string> = {};
    debug.breakpoints = [
      new SourceBreakpoint({
        uri: { scheme: 'file', fsPath: path.join(fixture!.root, 'dcmod.py') },
        range: { start: { line: DOTTED_LINE - 1 } },
      }),
    ];

    let sessions = 0;
    try {
      ({ sessions } = await inCell(
        nb,
        [
          'def helper():',
          '    breakpoint()',
          '    return "h"',
          'def go():',
          '    breakpoint()',
          'go()',
        ].join('\n'),
        async (dap) => {
          seen.breakpoint = await dap.value('helper()');
          seen.dot = await dap.value('dcmod.dotted()');
        },
      ));
    } finally {
      debug.breakpoints = [];
    }
    closeSessionFor(nb.key);

    expect(seen).toEqual({ breakpoint: "'h'", dot: '42' });
    // The one pause the cell made; none from the console's calls.
    expect(sessions).toBe(1);
  });

  it('tells VS Code to read the variables again, so a change made in the console shows', async () => {
    const nb = notebook('dc-invalidate');
    let change: Evaluated | undefined;
    let watched: Evaluated | undefined;
    let x = '';

    await inCell(
      nb,
      [
        'class Box:',
        '    def __init__(self):',
        '        self.x = 1',
        'def go(b):',
        '    breakpoint()',
        'go(Box())',
      ].join('\n'),
      async (dap) => {
        change = await dap.evaluate('b.x = 10');
        watched = await dap.evaluate('b.x', { context: 'watch' });
        const box = (await dap.locals()).find((v) => v.name === 'b')!;
        x = (await dap.children(box.variablesReference)).find((v) => v.name === 'x')!.value;
      },
    );
    closeSessionFor(nb.key);

    expect(change).toMatchObject({ ok: true, invalidated: true });
    // A watch is a row, so it reads as one, type badge and all.
    expect(watched).toMatchObject({ ok: true, result: '{int} 10', invalidated: false });
    expect(x).toBe('{int} 10');
  });

  it('puts a change to a persistent object made in the console in the notebook’s transaction', async () => {
    const nb = notebook('dc-transaction');

    await inCell(nb, PAUSE_ONCE, async (dap) => {
      await dap.value('import gemdb\ngemdb.root["dc_console"] = 1');
    });
    const session = sessionForIfOpen(nb.key)!;
    const dirty = await session.executeAsync(needsCommitQuery());
    await session.executeAsync(abortQuery());
    closeSessionFor(nb.key);

    // As the same line in a cell would: the notebook's next commit writes it.
    expect(dirty).toBe('true');
  });
  it('puts a Variables row in the Debug Console, and evaluates with self bound to it', async () => {
    const nb = notebook('dc-row');
    const seen: Record<string, unknown> = {};

    await inCell(
      nb,
      [
        'class Box:',
        '    def __init__(self, n):',
        '        self.x = n',
        '        self.items = [n, n]',
        '    def look(self, other, big):',
        '        breakpoint()',
        'Box(1).look(Box(5), list(range(1000)))',
      ].join('\n'),
      async (dap) => {
        const outputs = async (args: Record<string, unknown>) => {
          const from = dap.sent.length;
          const reply = await dap.request('gemdbShowRow', args);
          return {
            ok: reply.success,
            out: dap.sent
              .slice(from)
              .filter((m) => m.event === 'output')
              .map(
                (m) => m.body as { category: string; output: string; variablesReference?: number },
              ),
          };
        };
        const other = (await dap.locals()).find((v) => v.name === 'other')!;
        const shown = await outputs({ handle: other.variablesReference, name: 'other' });
        seen.shown = shown;
        // Everything shown is listed from one reference, so it all reads alike.
        const listed = async (shownRows: { out: Array<{ variablesReference?: number }> }) =>
          dap.children(shownRows.out.find((o) => o.variablesReference)?.variablesReference ?? 0);
        // An object: a line naming it, then its attributes, each with its name.
        const rows = await listed(shown);
        seen.rows = rows.map((v) => v.value);
        const items = rows.find((v) => v.value.startsWith('items'))!;
        seen.items = (await dap.children(items.variablesReference)).map((v) => v.value);
        // A list: one closed row, which opens like the Variables row.
        const big = await listed(
          await outputs({
            handle: (await dap.locals()).find((v) => v.name === 'big')!.variablesReference,
            name: 'big',
          }),
        );
        seen.big = big.map((v) => v.value);
        seen.bigOpened = (
          await dap.request('variables', {
            variablesReference: big[0].variablesReference,
            start: 998,
            count: 2,
          })
        ).body?.variables;
        const withSelf = await outputs({
          handle: other.variablesReference,
          name: 'other',
          expression: 'self.x * 10',
          frameId: 1,
        });
        seen.echo = withSelf.out[0];
        seen.withSelf = (await listed(withSelf)).map((v) => v.value);
        // What Show leaves at the prompt: a Locals row's own name, which means
        // it there; for a nested row, `_`, bound to it.
        seen.typedLocal = (
          await dap.request('gemdbShowRow', {
            handle: other.variablesReference,
            name: 'other',
            frameId: 1,
          })
        ).body?.typed;
        seen.typedNested = (
          await dap.request('gemdbShowRow', {
            handle: items.variablesReference,
            name: 'items',
            frameId: 1,
          })
        ).body?.typed;
        seen.underscore = await dap.value('_', 1);
        // The frame's own self is still the Box it was: the binding was for that line alone.
        seen.frameSelf = await dap.value('self.x');
        const scopes = (await dap.request('scopes', { frameId: 2 })).body?.scopes as Array<{
          name: string;
          variablesReference: number;
        }>;
        const groups = await dap.children(
          scopes.find((sc) => sc.name === 'Globals')!.variablesReference,
        );
        const group = groups.find((v) => v.name === 'class variables')!;
        seen.group = await outputs({ handle: group.variablesReference, name: 'class variables' });
      },
    );
    closeSessionFor(nb.key);

    expect(seen.shown).toMatchObject({ ok: true, out: [{ category: 'console', output: '' }] });
    // Its data in name order, as Variables lists it, without the folded groups.
    expect(seen.rows).toEqual([expect.stringMatching(/^other: .*Box/), 'items: [5, 5]', 'x: 5']);
    expect(seen.items).toEqual(['{int} 5', '{int} 5']);
    expect(seen.big).toEqual(['big: list with 1000 items']);
    expect(seen.bigOpened).toEqual([
      expect.objectContaining({ name: '[998]', value: '{int} 998' }),
      expect.objectContaining({ name: '[999]', value: '{int} 999' }),
    ]);
    expect(seen.echo).toEqual({
      category: 'console',
      output: '>>> self.x * 10  # self is other\n',
    });
    expect(seen.withSelf).toEqual(['50']);
    expect(seen.frameSelf).toBe('1');
    expect(seen.typedLocal).toBe('other');
    expect(seen.typedNested).toBe('_');
    expect(seen.underscore).toBe('[5, 5]');
    expect(seen.group).toMatchObject({
      ok: true,
      out: [{ category: 'stderr', output: expect.stringMatching(/not an object of its own/) }],
    });
  });
  it('runs GemDB’s % commands: %persist, %names, %commit, and completes them', async () => {
    const nb = notebook('dc-commands');
    const seen: Record<string, unknown> = {};

    await inCell(
      nb,
      [
        'class Item:',
        '    def __init__(self, sku, qty):',
        '        self.sku, self.qty = sku, qty',
        'def go(items):',
        '    breakpoint()',
        'go([Item("B400", "2"), Item("A200", 1)])',
      ].join('\n'),
      async (dap) => {
        await dap.value('p = [(i.sku, i.qty, type(i.qty).__name__) for i in items]');
        const said = async (line: string) => {
          const from = dap.sent.length;
          const r = await dap.evaluate(line);
          return {
            ok: r.ok,
            message: r.message,
            text: dap.sent
              .slice(from)
              .filter((m) => m.event === 'output')
              .map((m) => String(m.body?.output ?? ''))
              .join(''),
          };
        };
        seen.persist = await said('%persist p');
        seen.persistAs = await said('%persist items[0] as first_item');
        seen.noKey = await said('%persist items[0]');
        seen.names = await said('%names');
        // As Persisted Objects copies it: the program never imported gemdb, and it still works.
        seen.inRoot = await dap.value('gemdb.root["p"]');
        const complete = async (text: string) =>
          (
            (await dap.request('completions', { text, column: text.length + 1, frameId: 1 })).body
              ?.targets as Array<{ label: string }>
          ).map((t) => t.label);
        seen.completeCommands = await complete('%');
        seen.completeNames = await complete('%persist ');
        seen.commit = await said('%commit');
      },
    );
    // Committed: another session sees it.
    seen.elsewhere = await executeAsync(
      `System abortTransaction. ((System myUserProfile symbolList objectNamed: #'ModuleAst') evaluateSource: 'import gemdb\n(gemdb.root["p"], gemdb.root["first_item"].sku)' usingModuleScope: SymbolDictionary new) printString encodeAsUTF8`,
    );
    closeSessionFor(nb.key);

    expect(seen.persist).toMatchObject({
      ok: true,
      text: expect.stringMatching(
        /^Added p to Persisted Objects as gemdb.root\["p"\]\. It is saved when dc-commands\.ipynb commits/,
      ),
    });
    expect(seen.persistAs).toMatchObject({
      ok: true,
      text: expect.stringContaining('gemdb.root["first_item"]'),
    });
    expect(seen.noKey).toMatchObject({
      ok: false,
      message: 'Give it a key: %persist items[0] as some_key',
    });
    expect(seen.names).toMatchObject({
      ok: true,
      text: "p: list = [('B400', '2', 'str'), ('A200', 1, 'int')]\n",
    });
    expect(seen.inRoot).toBe("[('B400', '2', 'str'), ('A200', 1, 'int')]");
    expect(seen.completeCommands).toEqual(['%persist', '%commit', '%names', '%help']);
    expect(seen.completeNames).toEqual(['p']);
    expect(seen.commit).toMatchObject({
      ok: true,
      text: expect.stringMatching(/^Committed dc-commands\.ipynb/),
    });
    expect(seen.elsewhere).toContain("'B400'");
  });
  it('makes what Persisted Objects holds available by its key at a later pause', async () => {
    const nb = notebook('dc-persisted-names');
    // Persisted earlier, as %persist would leave it after %commit.
    await runPython(
      'import gemdb\ngemdb.root["kept"] = [1, 2]\ngemdb.root["n"] = "persisted n"\ngemdb.root["list"] = "not the builtin"\ngemdb.root["two words"] = 2\ngemdb.commit()',
      nb,
    );
    const seen: Record<string, unknown> = {};

    await inCell(nb, 'def go(n):\n    breakpoint()\ngo("the local n")', async (dap) => {
      seen.kept = await dap.value('kept');
      // Said above a persisted value; nothing said for the paused code's own name.
      seen.keptSaid = (await dap.evaluate('kept')).printed;
      seen.nSaid = (await dap.evaluate('n')).printed;
      await dap.value('kept2 = kept');
      seen.rebound = (await dap.evaluate('kept2')).printed;
      // Rebind kept in the console: persisted.kept still reaches the persisted one.
      await dap.value('kept = "mine now"');
      seen.keptMine = await dap.value('kept');
      seen.persistedKept = await dap.value('persisted.kept');
      seen.persistedN = await dap.value('persisted.n');
      seen.persistedList = await dap.value('persisted');
      seen.persistedNope = await dap.raises('persisted.nope');
      // The frame's own name wins over a persisted one of the same name.
      seen.n = await dap.value('n');
      // A builtin is never hidden.
      seen.list = await dap.value('list((1, 2))');
      seen.names = (await dap.evaluate('%names')).printed;
    });
    closeSessionFor(nb.key);

    expect(seen).toEqual({
      kept: '[1, 2]',
      keptSaid: 'kept is gemdb.root["kept"], from Persisted Objects (also persisted.kept)\n',
      keptMine: "'mine now'",
      persistedKept: '[1, 2]',
      persistedN: "'persisted n'",
      // Earlier tests in this file commit their own entries too.
      persistedList: expect.stringMatching(
        /^Persisted Objects: (.*, )?kept, list, n, (.*, )?two words$/,
      ),
      persistedNope: "AttributeError: Persisted Objects has no 'nope'",
      nSaid: '',
      // A name the user bound is theirs: nothing said.
      rebound: '',
      n: "'the local n'",
      list: '[1, 2]',
      // Persisted names are there to use, not names the user bound here: only kept2 is.
      names: 'kept2: list = [1, 2]\n',
    });
  });
});
