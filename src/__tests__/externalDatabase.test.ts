import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSettings, __setSetting } from '../__mocks__/vscode';
import {
  DB_USER,
  NETLDI_NAME,
  PINNED_ENGINE_VERSION,
  STONE_NAME,
  dbPassword,
  dbUser,
  engineVersion,
  externalDatabase,
  netldiName,
  stoneName,
} from '../config';
import { cliPath, writeCliScripts } from '../cli';
import { isInstalled } from '../lifecycle';
import { enginePath, expectedEnginePath, grailPath } from '../paths';
import {
  EngineProcess,
  ExternalDatabaseError,
  engineEnvironment,
  ensureProcesses,
  findNetldi,
  findStone,
  startStone,
  stopNetldi,
  stopStone,
} from '../processes';

/**
 * A database someone else runs: GemDB connects to it, installs Python into the
 * configured account, and never downloads, creates, starts or stops anything.
 * See `externalDatabase` in config.ts.
 */

let scratch: string;
let root: string;
let gemstone: string;

/** An engine directory with just the version file GemDB reads. */
function makeEngine(version = '4.0.0.a4'): string {
  const dir = path.join(scratch, 'product');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'version.txt'),
    `GemStone/S 64 Bit\n${version} Build: 2026-09-25T17:28:01-07:00 c12a2f4\n`,
  );
  return dir;
}

function stageGrailMarker(): void {
  fs.mkdirSync(grailPath(), { recursive: true });
  fs.writeFileSync(path.join(grailPath(), 'GRAIL_VERSION'), 'grail=test\n');
}

function useExternal(settings: Record<string, string> = {}): void {
  __setSetting('gemdb.externalDatabase.gemstone', gemstone);
  for (const [key, value] of Object.entries(settings)) {
    __setSetting(`gemdb.externalDatabase.${key}`, value);
  }
}

function process_(type: EngineProcess['type'], name: string): EngineProcess {
  return { type, name, version: '4.0.0.a4', pid: 1, port: 50377, status: 'OK', responding: true };
}

beforeEach(() => {
  __resetSettings();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-external-'));
  root = path.join(scratch, 'GemDB');
  fs.mkdirSync(root);
  __setSetting('gemdb.rootPath', root);
  gemstone = makeEngine();
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('settings', () => {
  it('is off unless the product directory is set, and GemDB keeps its own names', () => {
    __setSetting('gemdb.rootPath', scratch);
    fs.mkdirSync(path.join(scratch, 'db', 'conf'), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'db', 'conf', 'gemdb.password'), 'generated\n');

    expect(externalDatabase()).toBeUndefined();
    expect(stoneName()).toBe(STONE_NAME);
    expect(netldiName()).toBe(NETLDI_NAME);
    expect(dbUser()).toBe(DB_USER);
    expect(dbPassword()).toBe('generated');
  });

  it('defaults to the conventional GemStone names and the stock account', () => {
    useExternal();
    expect(externalDatabase()).toEqual({
      gemstone,
      globalDirectory: '/opt/gemstone',
      stone: 'gs64stone',
      netldi: 'gs64ldi',
      user: 'DataCurator',
      passwordFile: undefined,
    });
    expect(dbPassword()).toBe('swordfish');
  });

  it('uses the configured names and account', () => {
    useExternal({ stone: 'prod', netldi: 'prodldi', user: 'gemdb', globalDirectory: scratch });
    expect(stoneName()).toBe('prod');
    expect(netldiName()).toBe('prodldi');
    expect(dbUser()).toBe('gemdb');
    expect(externalDatabase()?.globalDirectory).toBe(scratch);
  });

  it('treats a blank setting as its default', () => {
    useExternal({ stone: '  ', user: '' });
    expect(stoneName()).toBe('gs64stone');
    expect(dbUser()).toBe('DataCurator');
  });

  it('expands ~ in the paths', () => {
    useExternal({ passwordFile: '~/.gemdb-password' });
    expect(externalDatabase()?.passwordFile).toBe(path.join(os.homedir(), '.gemdb-password'));
  });
});

describe('the password file', () => {
  it('reads the first line, trimmed', () => {
    const file = path.join(scratch, 'password');
    fs.writeFileSync(file, '  s3cret \nsecond line\n');
    useExternal({ passwordFile: file });
    expect(dbPassword()).toBe('s3cret');
  });

  it('names the setting when the file cannot be read', () => {
    useExternal({ passwordFile: path.join(scratch, 'missing') });
    expect(() => dbPassword()).toThrow(/gemdb\.externalDatabase\.passwordFile/);
  });

  it('refuses an empty file rather than logging in with no password', () => {
    const file = path.join(scratch, 'password');
    fs.writeFileSync(file, '\n');
    useExternal({ passwordFile: file });
    expect(() => dbPassword()).toThrow(/is empty/);
  });
});

describe('the engine', () => {
  it("is the administrator's product directory", () => {
    useExternal();
    expect(enginePath()).toBe(gemstone);
  });

  it('is missing when that directory is', () => {
    __setSetting('gemdb.externalDatabase.gemstone', path.join(scratch, 'nowhere'));
    expect(enginePath()).toBeUndefined();
  });

  it("reports the product's own version, which names the GCI library", () => {
    gemstone = makeEngine('4.0.0.a9');
    useExternal();
    expect(engineVersion()).toBe('4.0.0.a9');
  });

  it('falls back to the pin when the version file is unreadable', () => {
    fs.rmSync(path.join(gemstone, 'version.txt'));
    useExternal();
    expect(engineVersion()).toBe(PINNED_ENGINE_VERSION);
  });

  it('still lets the version setting win', () => {
    useExternal();
    __setSetting('gemdb.engineVersion', '4.0.0.a1');
    expect(engineVersion()).toBe('4.0.0.a1');
  });
});

describe('isInstalled', () => {
  it('needs only the engine and staged Grail, not a database GemDB created', () => {
    useExternal();
    expect(isInstalled()).toBe(false);
    stageGrailMarker();
    expect(isInstalled()).toBe(true);
  });

  it('still needs a database of its own when not external', () => {
    fs.mkdirSync(expectedEnginePath(), { recursive: true });
    stageGrailMarker();
    expect(enginePath()).toBe(expectedEnginePath());
    expect(isInstalled()).toBe(false);
  });
});

describe('engineEnvironment', () => {
  it("points at the administrator's engine and lock directory, and leaves their config alone", () => {
    useExternal({ globalDirectory: '/srv/gemstone' });
    const env = engineEnvironment();
    expect(env.GEMSTONE).toBe(gemstone);
    expect(env.GEMSTONE_GLOBAL_DIR).toBe('/srv/gemstone');
    expect(env.GRAIL_DIR).toBe(grailPath());
    expect(env).not.toHaveProperty('GEMSTONE_SYS_CONF');
    expect(env).not.toHaveProperty('GEMSTONE_EXE_CONF');
    expect(env).not.toHaveProperty('GEMSTONE_NRS_ALL');
  });

  it('says which setting to fix when the engine is missing', () => {
    __setSetting('gemdb.externalDatabase.gemstone', path.join(scratch, 'nowhere'));
    expect(() => engineEnvironment()).toThrow(/gemdb\.externalDatabase\.gemstone/);
  });
});

describe('processes', () => {
  const running = [process_('stone', 'gs64stone'), process_('netldi', 'gs64ldi')];

  it('are found by the configured names', () => {
    useExternal();
    expect(findStone(running)?.name).toBe('gs64stone');
    expect(findNetldi(running)?.name).toBe('gs64ldi');
  });

  it("are not GemDB's own when not external", () => {
    expect(findStone(running)).toBeUndefined();
    expect(findNetldi(running)).toBeUndefined();
  });

  it('are never started or stopped by GemDB', async () => {
    useExternal();
    await expect(startStone()).rejects.toBeInstanceOf(ExternalDatabaseError);
    await expect(ensureProcesses()).rejects.toBeInstanceOf(ExternalDatabaseError);
    await expect(stopStone()).rejects.toBeInstanceOf(ExternalDatabaseError);
    await expect(stopNetldi()).rejects.toBeInstanceOf(ExternalDatabaseError);
  });
});

describe('the gemdb command', () => {
  let ext: string;

  beforeEach(() => {
    ext = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-ext-'));
    fs.mkdirSync(path.join(ext, 'out'), { recursive: true });
    fs.writeFileSync(path.join(ext, 'out', 'gemdb-shell.js'), '// the shell bundle\n');
    const koffi = path.join(ext, 'node_modules', 'koffi');
    const machine = `${process.platform}_${process.arch}`;
    fs.mkdirSync(path.join(koffi, 'build', 'koffi', machine), { recursive: true });
    fs.writeFileSync(path.join(koffi, 'package.json'), '{"name":"koffi"}\n');
    fs.writeFileSync(path.join(koffi, 'build', 'koffi', machine, 'koffi.node'), 'native\n');
  });

  afterEach(() => {
    fs.rmSync(ext, { recursive: true, force: true });
  });

  it('uses the external database and never starts it', () => {
    const file = path.join(scratch, 'password');
    fs.writeFileSync(file, 's3cret\n');
    useExternal({ user: 'gemdb', passwordFile: file, globalDirectory: '/srv/gemstone' });
    writeCliScripts(ext);

    const script = fs.readFileSync(cliPath(), 'utf8');
    expect(script).toContain(`GEMSTONE="${gemstone}"`);
    expect(script).toContain('STONE="gs64stone"');
    expect(script).toContain(`export GEMDB_ROOT_PATH="$ROOT"`);
    expect(script).toContain('export GEMSTONE_GLOBAL_DIR="/srv/gemstone"');
    expect(script).toContain(`export GEMDB_EXTERNAL_PASSWORD_FILE="${file}"`);
    expect(script).not.toContain('GEMSTONE_SYS_CONF');
    expect(script).toContain("It is run by this machine's administrator.");

    const driver = path.join(path.dirname(cliPath()), 'gemdb-run.tpz');
    const text = fs.readFileSync(driver, 'utf8');
    expect(text).toContain('set user gemdb pass s3cret');
    expect(text).toContain('set gemstone gs64stone');
    // It carries a real password, so only this user may read it.
    expect(fs.statSync(driver).mode & 0o777).toBe(0o600);
  });
});

describe('the shell program', () => {
  it('reads the root path and the external settings from the wrapper', async () => {
    vi.resetModules();
    vi.stubEnv('GEMDB_ROOT_PATH', '/home/dev/GemDB');
    vi.stubEnv('GEMSTONE_GLOBAL_DIR', '/opt/gemstone');
    vi.stubEnv('GEMDB_EXTERNAL_STONE', 'gs64stone');
    try {
      const { workspace } = await import('../cliVscode');
      const config = workspace.getConfiguration('gemdb');
      expect(config.get('rootPath', '~/GemDB')).toBe('/home/dev/GemDB');
      expect(config.get('externalDatabase.stone', 'x')).toBe('gs64stone');
      expect(config.get('externalDatabase.user', 'DataCurator')).toBe('DataCurator');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('falls back to GEMSTONE_GLOBAL_DIR for wrappers generated before GEMDB_ROOT_PATH', async () => {
    vi.resetModules();
    vi.stubEnv('GEMDB_ROOT_PATH', undefined);
    vi.stubEnv('GEMSTONE_GLOBAL_DIR', '/home/dev/GemDB');
    try {
      const { workspace } = await import('../cliVscode');
      expect(workspace.getConfiguration('gemdb').get('rootPath', '~/GemDB')).toBe(
        '/home/dev/GemDB',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
