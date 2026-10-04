/** Exit codes (SPEC §4). */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  invalidTransition: 3,
  notInTask: 4,
  aoeIncompatible: 5,
  configInvalid: 78,
} as const;

export class CliError extends Error {
  constructor(
    message: string,
    public exitCode: number = EXIT.error,
    public hint: string | null = null,
  ) {
    super(message);
  }
}
