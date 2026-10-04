#!/usr/bin/env node
import { buildProgram } from './cli.ts';
import { CliError } from './util/errors.ts';
import { c, err } from './util/term.ts';

buildProgram()
  .parseAsync(process.argv)
  .catch((e: unknown) => {
    if (e instanceof CliError) {
      err(`${c.red('error')} ${e.message}`);
      if (e.hint)
        err(
          e.hint
            .split('\n')
            .map((l) => `  ${l}`)
            .join('\n'),
        );
      process.exit(e.exitCode);
    }
    err(`${c.red('error')} ${(e as Error)?.stack ?? String(e)}`);
    process.exit(1);
  });
