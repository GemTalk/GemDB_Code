import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initUnattendedSetupMarker,
  readUnattendedSetupMarker,
  writeUnattendedSetupMarker,
} from '../unattendedSetupMarker';

let storage: string;

beforeEach(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), 'gemdb-marker-'));
  initUnattendedSetupMarker(storage);
});

afterEach(() => fs.rmSync(storage, { recursive: true, force: true }));

describe('the unattended setup marker', () => {
  it('reads as none when no marker has been written', () => {
    expect(readUnattendedSetupMarker()).toBe('none');
  });

  it('round-trips a write', () => {
    writeUnattendedSetupMarker('completed');

    expect(readUnattendedSetupMarker()).toBe('completed');
  });

  it('reads unknown content as attempted, since it still says setup was offered', () => {
    fs.mkdirSync(storage, { recursive: true });
    fs.writeFileSync(path.join(storage, 'setup-attempted'), 'some-nonsense');

    expect(readUnattendedSetupMarker()).toBe('attempted');
  });

  it('reads a legacy timestamp, written before outcomes were recorded, as attempted', () => {
    fs.mkdirSync(storage, { recursive: true });
    fs.writeFileSync(path.join(storage, 'setup-attempted'), new Date().toISOString());

    expect(readUnattendedSetupMarker()).toBe('attempted');
  });

  it('creates the storage directory if the extension has never written there', () => {
    const fresh = path.join(storage, 'never-used');
    initUnattendedSetupMarker(fresh);

    writeUnattendedSetupMarker('completed');

    expect(fs.existsSync(path.join(fresh, 'setup-attempted'))).toBe(true);
  });

  describe('before initUnattendedSetupMarker has run', () => {
    it('throws rather than silently reading or writing', async () => {
      vi.resetModules();
      const fresh = await import('../unattendedSetupMarker');

      expect(() => fresh.readUnattendedSetupMarker()).toThrow();
      expect(() => fresh.writeUnattendedSetupMarker('completed')).toThrow();
    });
  });
});
