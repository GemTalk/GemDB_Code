import * as fs from 'fs';
import { ADMIN_PASSWORD, ADMIN_USER, DB_USER, databasePasswordPath } from './config';
import { ensurePasswordFile } from './database';
import { log, logStep } from './log';
import { mcpStampPath, removeGrailStamps } from './paths';
import { GciSession, SessionOwner } from './session';

/**
 * The `gemdb` account on a database GemDB manages: what it is and why lives
 * on `DB_USER` in config.ts.
 *
 * Created by DataCurator, which holds the privileges this needs
 * (`OtherPassword`, `ObjectSecurityPolicyCreation`) — measured on 4.0.0.a4,
 * DataCurator can create the account with its own security policy and grant
 * both of its privileges, so SystemUser is not involved. The account gets its
 * own security policy, as GemDB Cloud's does, so what it creates is its own.
 */

const ADMIN_OWNER: SessionOwner = {
  key: '__account__',
  kind: 'extension',
  label: 'GemDB (DataCurator)',
};

/** The privileges `gemdb` holds, and no more. */
export const DB_USER_PRIVILEGES = ['CodeModification', 'CreateOnetimePassword'];

/**
 * Smalltalk that creates the account if it is missing — or, when `reset`,
 * gives an existing one `password` — and answers which it did.
 *
 * Pure, so the shape can be tested without a database.
 */
export function accountQuery(password: string, reset: boolean): string {
  const grants = DB_USER_PRIVILEGES.map((p) => `u addPrivilege: #${p}.`).join(' ');
  return [
    '| u |',
    `u := AllUsers userWithId: '${DB_USER}' ifAbsent: [nil].`,
    'u isNil',
    `  ifTrue: [u := AllUsers addNewUserWithId: '${DB_USER}' password: '${password}'`,
    '      createNewSecurityPolicy: true.',
    `    ${grants}`,
    "    System commitTransaction. 'created']",
    reset
      ? `  ifFalse: [u password: '${password}'. System commitTransaction. 'reset']`
      : "  ifFalse: ['present']",
  ].join('\n');
}

/**
 * Make sure the account exists and its password is the one on disk. Needs the
 * stone and the listener running; called on the way to a running database,
 * before Python is installed into the account.
 *
 * The password file is written with the database (`createDatabase`); one is
 * written here only for a database without it, so this changes nothing on an
 * ordinary start. A database that gains the account here has nothing
 * installed in it yet, so the records that say Python support and the MCP
 * server are installed are cleared, and the next steps install them into it.
 */
export function ensureDatabaseAccount(): void {
  const file = databasePasswordPath();
  const missing = ensurePasswordFile();
  const password = fs.readFileSync(file, 'utf8').trim();

  const session = GciSession.login(ADMIN_OWNER, { user: ADMIN_USER, password: ADMIN_PASSWORD });
  let outcome: string;
  try {
    outcome = session.execute(accountQuery(password, missing));
  } finally {
    session.logout();
  }

  if (outcome === 'created') {
    logStep(`Created the ${DB_USER} database account`);
    removeGrailStamps();
    fs.rmSync(mcpStampPath(), { force: true });
  } else if (outcome === 'reset') {
    log(`Gave the ${DB_USER} account a new password: ${file} was missing.`);
  }
}
