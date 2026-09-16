#!/usr/bin/env node
//
// Asserts that the project's own `tsc` is TypeScript 7.
//
// Two installed packages claim the `tsc` bin: `@typescript/native` (TS 7, the
// compiler `typecheck` and `typecheck:strict` run) and
// `@typescript/old` (the real typescript@6, hoisted to top level as a
// dependency of the `@typescript/typescript6` alias that typescript-eslint
// reads). npm resolves the collision in favour of the direct dependency, but
// nothing declares that, and the failure mode is silent: this project
// type-checks clean on TS 6 too, so a reshuffle would downgrade the whole
// build with a green CI run and no output difference.
//
// The binary is resolved as `node_modules/.bin/tsc` next to this script's own
// file, not via PATH. Run through `npm run`, PATH would happen to agree, but
// run directly with `node scripts/lint-toolchain.mjs` it would find whatever
// `tsc` is installed globally, which is not the compiler the npm scripts
// actually use and defeats the point of the check.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const tscPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'node_modules',
  '.bin',
  'tsc',
);

let out;
try {
  out = execFileSync(tscPath, ['--version'], { encoding: 'utf8' }).trim();
} catch (err) {
  fail(
    err.code === 'ENOENT'
      ? `there is no "${tscPath}".\n` +
          'node_modules is missing or incomplete. Reinstall, ' +
          'or point the typecheck scripts at @typescript/native explicitly. ' +
          'If the install layout has changed instead — a workspace hoisting ' +
          'the bin to its own root, or a package manager that writes no ' +
          '.bin at all — nothing is wrong with the install and this ' +
          "script's resolution is what needs to follow it."
      : `could not run "${tscPath}": ${err.message}\n` +
          'The binary is there but would not report a version, so this says ' +
          'nothing about which TypeScript the typecheck scripts will get.',
  );
}
if (/Version (\d+)\./.exec(out)?.[1] !== '7') {
  fail(
    `tsc is "${out}" — expected TypeScript 7.\n` +
      'node_modules/.bin/tsc has been linked to the TS 6 package. Reinstall, ' +
      'or point the typecheck scripts at @typescript/native explicitly.',
  );
} else {
  console.log(`tsc is ${out} — OK`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
