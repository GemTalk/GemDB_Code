import { describe, expect, it } from 'vitest';
import {
  ClaudeCodeWorld,
  RunResult,
  addArgs,
  connectClaudeCode,
  connectableFolder,
  removeArgs,
  spelled,
} from '../claudeCode';

/**
 * A stand-in editor and Claude Code CLI that record what was run.
 *
 * The CLI's answers are the ones measured against Claude Code 2.1.283: `add`
 * fails with exit 1, saying the name "already exists in local config", when
 * there is one, and `remove` fails with exit 1 when there is not.
 */
function makeWorld(options: {
  folders?: string[];
  trusted?: boolean;
  claude?: string | undefined;
  /** Whether a local-scope gemdb entry already exists in the folder. */
  alreadyAdded?: boolean;
  /** What the user answers when asked to replace that entry. */
  replace?: boolean;
  /** Make every add fail with this output, as a broken CLI would. */
  addFails?: string;
  /** Make only the add after a remove fail with this output. */
  readdFails?: string;
  removeFails?: string;
}): { world: ClaudeCodeWorld; ran: string[]; asked: string[] } {
  const ran: string[] = [];
  const asked: string[] = [];
  let present = options.alreadyAdded ?? false;
  let removed = false;

  const world: ClaudeCodeWorld = {
    findClaude: () => ('claude' in options ? options.claude : '/bin/claude'),
    folders: () => options.folders ?? ['/home/dev/project'],
    trusted: () => options.trusted ?? true,
    confirmReplace: (folder) => {
      asked.push(folder);
      return Promise.resolve(options.replace ?? true);
    },
    run: (claude, args, cwd): Promise<RunResult> => {
      ran.push(`${claude} ${args.join(' ')} @ ${cwd}`);
      if (args[1] === 'remove') {
        if (options.removeFails) return Promise.resolve({ code: 1, output: options.removeFails });
        const had = present;
        present = false;
        removed = had;
        return Promise.resolve({ code: had ? 0 : 1, output: '' });
      }
      if (options.addFails) return Promise.resolve({ code: 1, output: options.addFails });
      if (removed && options.readdFails) {
        return Promise.resolve({ code: 1, output: options.readdFails });
      }
      if (present) {
        return Promise.resolve({
          code: 1,
          output: 'MCP server gemdb already exists in local config',
        });
      }
      present = true;
      return Promise.resolve({ code: 0, output: 'Added' });
    },
  };
  return { world, ran, asked };
}

const url = 'http://127.0.0.1:50390/mcp';
const verbs = (ran: string[]): string[] => ran.map((r) => r.split(' ')[2]);

describe('connecting Claude Code to GemDB', () => {
  it('adds the server for the open folder, at local scope, over HTTP', async () => {
    const { world, ran } = makeWorld({});

    const outcome = await connectClaudeCode(world, url);

    expect(outcome).toEqual({ kind: 'connected', folder: '/home/dev/project', replaced: false });
    expect(ran).toEqual([
      `/bin/claude mcp add --transport http --scope local gemdb ${url} @ /home/dev/project`,
    ]);
  });

  it('replaces an earlier entry once the user agrees, which is how a new port is picked up', async () => {
    const { world, ran, asked } = makeWorld({ alreadyAdded: true });

    const outcome = await connectClaudeCode(world, 'http://127.0.0.1:50400/mcp');

    expect(asked).toEqual(['/home/dev/project']);
    expect(verbs(ran)).toEqual(['add', 'remove', 'add']);
    expect(outcome).toEqual({ kind: 'connected', folder: '/home/dev/project', replaced: true });
  });

  it('leaves an existing entry alone when the user declines to replace it', async () => {
    // It may be one the user wrote for something else under the same name.
    const { world, ran } = makeWorld({ alreadyAdded: true, replace: false });

    const outcome = await connectClaudeCode(world, url);

    expect(outcome).toEqual({ kind: 'cancelled' });
    expect(verbs(ran)).toEqual(['add']);
  });

  it('removes nothing when the add fails for any reason but the name being taken', async () => {
    const { world, ran, asked } = makeWorld({ addFails: 'Invalid URL' });

    const outcome = await connectClaudeCode(world, url);

    expect(outcome).toEqual({ kind: 'failed', output: 'Invalid URL', removedOld: false });
    expect(verbs(ran)).toEqual(['add']);
    expect(asked).toEqual([]);
  });

  it('says the old entry is gone when adding the new one fails after removing it', async () => {
    const { world } = makeWorld({ alreadyAdded: true, readdFails: 'claude was stopped' });

    const outcome = await connectClaudeCode(world, url);

    expect(outcome).toEqual({ kind: 'failed', output: 'claude was stopped', removedOld: true });
  });

  it('stops without adding when the old entry could not be removed', async () => {
    const { world, ran } = makeWorld({ alreadyAdded: true, removeFails: 'permission denied' });

    const outcome = await connectClaudeCode(world, url);

    expect(outcome).toEqual({ kind: 'failed', output: 'permission denied', removedOld: false });
    expect(verbs(ran)).toEqual(['add', 'remove']);
  });

  it('never asks the server anything, since each connection spends a database session', async () => {
    // `claude mcp get` and `claude mcp list` both connect to report status.
    const { world, ran } = makeWorld({ alreadyAdded: true });

    await connectClaudeCode(world, url);

    expect(verbs(ran).every((verb) => verb === 'add' || verb === 'remove')).toBe(true);
  });

  it('registers for the first folder of several, which is where the Claude Code panel runs', async () => {
    const { world, ran } = makeWorld({ folders: ['/home/dev/api', '/home/dev/web'] });

    const outcome = await connectClaudeCode(world, url);

    expect(outcome).toMatchObject({ kind: 'connected', folder: '/home/dev/api' });
    expect(ran.every((r) => r.endsWith('@ /home/dev/api'))).toBe(true);
  });

  it('runs nothing in an empty window, which has no project to register for', async () => {
    const { world, ran } = makeWorld({ folders: [] });

    const outcome = await connectClaudeCode(world, url);

    expect(outcome).toEqual({ kind: 'noFolder' });
    expect(ran).toEqual([]);
  });

  it('runs nothing in a folder VS Code has not been told to trust', async () => {
    const { world, ran } = makeWorld({ trusted: false });

    const outcome = await connectClaudeCode(world, url);

    expect(outcome).toEqual({ kind: 'untrusted' });
    expect(ran).toEqual([]);
  });

  it('says so when there is no Claude Code to run', async () => {
    const { world, ran } = makeWorld({ claude: undefined });

    const outcome = await connectClaudeCode(world, url);

    expect(outcome).toEqual({ kind: 'noClaude' });
    expect(ran).toEqual([]);
  });

  it('offers to connect only where it could actually run', () => {
    expect(connectableFolder(makeWorld({}).world)).toBe('/home/dev/project');
    expect(connectableFolder(makeWorld({ folders: [] }).world)).toBeUndefined();
    expect(connectableFolder(makeWorld({ trusted: false }).world)).toBeUndefined();
    expect(connectableFolder(makeWorld({ claude: undefined }).world)).toBeUndefined();
  });

  it('shows the undo as the command a user would type', () => {
    expect(spelled(removeArgs())).toBe('claude mcp remove gemdb --scope local');
    expect(spelled(addArgs(url))).toBe(
      `claude mcp add --transport http --scope local gemdb ${url}`,
    );
  });
});
