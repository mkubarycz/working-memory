export function instanceAttachmentBaseUrl(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid attachment instance port.');
  // Chromium interprets an all-numeric hostname as an IPv4 address for standard schemes.
  return `working-memory-attachment://instance-${port}`;
}
