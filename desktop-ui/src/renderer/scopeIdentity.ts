/** Historical Alert scopes refer to the same canonical AgentMessage document UUID. */
export function normalizeScopeKind(kind: string): string {
  const normalized = kind.toLowerCase().replaceAll('-', '');
  return normalized === 'alert' ? 'agentmessage' : normalized;
}
