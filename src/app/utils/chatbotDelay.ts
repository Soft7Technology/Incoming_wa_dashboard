export function parseChatbotDelay(value: unknown): number {
  const numericString = typeof value === 'string' && /^\d+$/.test(value.trim());
  const delay = numericString ? Number(value.trim()) : value;
  if (typeof delay !== 'number' || !Number.isSafeInteger(delay) || delay < 0 || delay > 2147483647) {
    throw new Error(`Invalid delay value ${JSON.stringify(value) ?? 'undefined'}. Use a whole number of milliseconds from 0 to 2147483647, such as 60000.`);
  }
  return delay;
}
