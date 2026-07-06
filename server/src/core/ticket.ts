/**
 * Extracts a Jira issue key (e.g. WEB-2257) from anywhere within a branch name.
 * Returns the first match, or null if none is found.
 */
export function extractTicketKey(branchName: string, regexSource: string): string | null {
  let re: RegExp;
  try {
    re = new RegExp(regexSource, 'g');
  } catch {
    // Fall back to a sensible default if the configured regex is invalid.
    re = /[A-Z][A-Z0-9]+-\d+/g;
  }
  const match = branchName.match(re);
  return match && match.length > 0 ? match[0]!.toUpperCase() : null;
}
