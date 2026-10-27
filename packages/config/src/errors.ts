/**
 * Thrown when environment configuration is missing or malformed.
 *
 * Carries every problem found rather than only the first, so a developer
 * fixes their `.env` in one pass instead of restarting the process repeatedly.
 */
export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(section: string, issues: readonly string[]) {
    const detail = issues.map((issue) => `  - ${issue}`).join('\n');
    super(`Invalid ${section} configuration:\n${detail}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}
