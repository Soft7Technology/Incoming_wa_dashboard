// Accept plain text and both internal/Meta text shapes without sending null bodies.
export function normalizeChatbotResponse(response: any): any | null {
  if (response == null || response.ignoreMessage) return null;
  if (typeof response === 'string') response = { text: response };
  const text = typeof response.text === 'string' ? response.text
    : typeof response.text?.body === 'string' ? response.text.body
    : typeof response.body === 'string' ? response.body : undefined;
  const type = response.type || (response.interactive ? 'interactive' : response.image ? 'image' : 'text');
  if (type === 'text') {
    if (!text?.trim()) return null;
    return { ...response, type: 'text', text };
  }
  return { ...response, type };
}

// Engine action chains return a messages envelope, including when later actions return null.
export async function sendChatbotResponseBatch(response: any, send: (message: any) => Promise<any>): Promise<any[]> {
  const results: any[] = [];
  async function visit(value: any): Promise<void> {
    if (value == null || value.ignoreMessage) return;
    if (Array.isArray(value.messages)) {
      for (const message of value.messages) await visit(message);
      return;
    }
    const message = normalizeChatbotResponse(value);
    if (message) results.push(await send(message));
  }
  await visit(response);
  return results;
}
