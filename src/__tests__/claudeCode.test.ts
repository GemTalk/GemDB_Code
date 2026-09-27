import { describe, expect, it } from 'vitest';
import {
  ClaudeCodeWorld,
  RunResult,
  addArgs,
  connectClaudeCode,
  removeArgs,
  spelled,
} from '../claudeCode';

/**
 * A stand-in editor and Claude Code CLI that record what was run.
 *
 * The CLI's answers are the ones measured against Claude Code 2.1.283: `add`
 * fails with exit 1 when the name already exists in that scope, and `remove`
 * fails with exit 1 when it does not.
 */
function makeWorld(options: {
  folders?: string[];
  trusted?: boolean;
  claude?: string | undefined;
  picked?: string;
  /** Whether a local-scope gemdb entry already exists in the chosen folder. */
  alreadyAdded?: boolean;
  addFails?: string;
}): { world: ClaudeCodeWorld; ran: string[]; picks: string[][] } {
  const ran: string[] = [];
  const picks: string[][] = [];
  let present = options.alreadyAdded ?? false;

  const world: ClaudeCodeWorld = {
    findClaude: () => ('claude' in options ? options.claude : '/bin/claude'),
    folders: () => options.folders ?? ['/home/dev/project'],
    pickFolder: (folders) => {
      picks.push(folders);
      return Promise.resolve(options.picked);
    },
    trusted: () => options.trusted ?? true,
    run: (claude, args, cwd): Promise<RunResult> => {
      ran.push(`${claude} ${args.join(' ')} @ ${cwd}`);
      if (args[1] === 'remove') {
        const had = present;
        present = false;
        return Promise.resolve({ code: had ? 0 : 1, output: '' });
      }
      if (options.addFails) return Promise.resolve({ code: 1, output: options.addFails });
      if (present) return Promise.resolve({ code: 1, output: 'already exists in local config' });
      present = true;
      return Promise.resolve({ code: 0, output: 'Added' });
    },
  };
  return { world, ran, picks };
}

const url = 'http://127.0.0.1:50390/mcp';

describe('connecting Claude Code to GemDB', () => {
  it('adds the server for the open folder, at local scope, over HTTP', async () => {
    const { world, ran } = makeWorld({});

    const outcome = await connectClaudeCode(world, url);

    expect(outcome).toEqual({ kind: 'connected', folder: '/home/dev/project', replaced: false });
    expect(ran.at(-1)).toBe(
      `/bin/claude mcp add --transport http --scope local gemdb ${url} @ /home/dev/project`,
    );
  });

  it('replaces an earlier entry, so running it again picks up a new port', async () => {
    const { world } = makeWorld({ alreadyAdded: true });

    const outcome = await connectClaudeCode(world, 'http://127.0.0.1:50400/mcp');

    expect(outcome).toEqual({ kind: 'connected', folder: '/home/dev/project', replaced: true });
  });

  it('never asks the server anything, since each connection spends a database session', async () => {
    // `claude mcp get` and `claude mcp list` both connect to report status.
    const { world, ran } = makeWorld({ alreadyAdded: true });

    await connectClaudeCode(world, url);

    expect(ran.map((r) => r.split(' ')[2])).toEqual(['remove', 'add']);
  });

  it('asks which folder when the window has several, and runs in the one picked', async () => {
    const folders = ['/home/dev/api', '/home/dev/web'];
    const { world, ran, picks } = makeWorld({ folders, picked: '/home/dev/web' });

    const outcome = await connectClaudeCode(world, url);

    expect(picks).toEqual([folders]);
    expect(outcome).toMatchObject({ kind: 'connected', folder: '/home/dev/web' });
    expect(ran.every((r) => r.endsWith('@ /home/dev/web'))).toBe(true);
  });

  it('runs nothing when the folder choice is dismissed', async () => {
    const { world, ran } = makeWorld({ folders: ['/a', '/b'], picked: undefined });

    const outcome = await connectClaudeCode(world, url);

    expect(outcome).toEqual({ kind: 'cancelled' });
    expect(ran).toEqual([]);
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

  it('passes on what Claude Code said when it could not add the server', async () => {
    const { world } = makeWorld({ addFails: 'Invalid URL' });

    const outcome = await connectClaudeCode(world, url);

    expect(outcome).toEqual({ kind: 'failed', output: 'Invalid URL' });
  });

  it('shows the undo as the command a user would type', () => {
    expect(spelled(removeArgs())).toBe('claude mcp remove gemdb --scope local');
    expect(spelled(addArgs(url))).toBe(
      `claude mcp add --transport http --scope local gemdb ${url}`,
    );
  });
});
