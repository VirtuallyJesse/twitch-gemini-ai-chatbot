/* Channel identity keys are lowercase with no leading '#'; display labels
   keep original casing but never render the prefix. */

export function normChannel(channel: string): string {
  return String(channel || '').replace(/^#/, '').toLowerCase();
}

export function channelLabel(channel: string): string {
  return String(channel || '').replace(/^#/, '');
}
