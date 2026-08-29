export const APT_BROWSER_COMMAND_TIMEOUT_SECONDS = 45;

export function browserProfileSettings(): [string, string][] {
  return [
    ['browser.backend', '"off"'],
    ['browser.allow_private_urls', 'false'],
    ['browser.restrict_evaluate', 'true'],
    ['browser.command_timeout', String(APT_BROWSER_COMMAND_TIMEOUT_SECONDS)],
  ];
}
