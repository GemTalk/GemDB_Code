import * as path from 'path';
import type { SessionOwner } from './session';

/**
 * Who a Debug Python File run belongs to. Its key is the file's path, which
 * no notebook URI can be, so a key alone says which kind of run it was —
 * including the one a saved stack records.
 */
export function fileOwner(file: string): SessionOwner {
  return { key: file, kind: 'file', label: path.basename(file) };
}

/** The file an owner key runs, if it is a file run's. */
export function runFileOf(ownerKey: string | null | undefined): string | undefined {
  return ownerKey && path.isAbsolute(ownerKey) && ownerKey.endsWith('.py') ? ownerKey : undefined;
}
