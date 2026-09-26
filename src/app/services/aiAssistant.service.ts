import aiAssistantModel from '../models/aiAssistant.model';
import messageModel from '../models/message.model';
import { decryptApiKey } from '../utils/crypto.util';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import axios, { AxiosError } from 'axios';

export const openAiModelMap: Record<string, string> = {
  'gpt-4o': 'gpt-4o',
  'gpt-4o mini': 'gpt-4o-mini',
  'gpt-4.1': 'gpt-4.1',
  'gpt-4.1 mini': 'gpt-4.1-mini',
};

type ProviderTestResult = {
  success: boolean;
  message: string;
  statusCode?: number;
  errorCode?: string;
};

class AIAgentService {
  /**
   * Generate one reply using the selected local assistant and scoped message history.
   * phoneNumberId is the local database ID; phone is the customer's international number.
   */
  async runAssistant(assistantId: string, userId: string, companyId: string, phoneNumberId: string, phone: string): Promise<string> {
    // Never silently select another assistant if the configured ID is unavailable.
    const assistant = await aiAssistantModel.findActiveOwned(assistantId, userId);
    if (!assistant) throw new Error('The selected AI assistant is unavailable for this account');
    // Use only this assistant's decrypted credential, with no environment-key fallback.
    const apiKey = decryptApiKey(assistant.api_key);
    if (!apiKey || apiKey.startsWith('enc:')) throw new Error('The selected AI assistant needs a valid API key');
    // Custom text takes precedence for custom mode; otherwise use the saved preset/role.
    const instruction = assistant.prompt_type === 'custom' ? assistant.custom_prompt
      : assistant.predefined_prompt || `You are a helpful assistant acting as a: ${assistant.role}.`;
    if (!instruction?.trim()) throw new Error('The selected AI assistant needs a prompt');
    const history = await messageModel.getRecentMessages(userId, companyId, phoneNumberId, phone, 10);
    // The webhook persists the current inbound message before invoking the chatbot.
    // Do not append it again: it is already included in the last ten rows.
    // The query returns newest first; providers receive the conversation oldest first.
    const messages = history.slice().reverse().map((row: any) => ({
      role: row.direction === 'inbound' ? 'user' : 'assistant', content: assistantMessageText(row),
    })).filter((message: any) => message.content);
    if (!messages.length) throw new Error('No message context is available');
    const provider = String(assistant.provider).trim().toLowerCase();
    const requestedModel = String(assistant.model || '').trim();
    if (!requestedModel) throw new Error('The selected AI assistant needs a model');
    let text = '';
    try {
      // Convert stored history into the selected provider's message format.
      if (provider.includes('openai')) {
        const result = await axios.post('https://api.openai.com/v1/chat/completions', {
          model: openAiModelMap[requestedModel.toLowerCase()] || requestedModel,
          messages: [{ role: 'system', content: instruction }, ...messages], store: false,
        }, { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 30000 });
        text = result.data?.choices?.[0]?.message?.content || '';
      } else if (provider.includes('gemini')) {
        const model = requestedModel.replace(/^models\//, '');
        const result = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          systemInstruction: { parts: [{ text: instruction }] },
          contents: messages.map((message: any) => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] })),
        }, { headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' }, timeout: 30000 });
        text = (result.data?.candidates?.[0]?.content?.parts || []).map((part: any) => part.text || '').join('');
      } else throw new Error('Unsupported AI provider');
    } catch {
      // Never propagate Axios request configuration: it contains the assistant's key.
      throw new Error('AI provider could not generate a response');
    }
    if (typeof text !== 'string' || !text.trim()) throw new Error('AI provider returned an empty response');
    return text.trim();
  }

  async testProviderConnection(
    provider: string,
    model: string,
    apiKey: string,
  ): Promise<ProviderTestResult> {
    const normalizedProvider = String(provider || '')
      .trim()
      .toLowerCase();

    try {
      if (normalizedProvider.includes('openai')) {
        const requestedModel = String(model || 'gpt-4o-mini')
          .trim()
          .toLowerCase();

        const openAiModel =
          openAiModelMap[requestedModel] ||
          requestedModel.replace(/\s+/g, '-');

        await axios.post(
          'https://api.openai.com/v1/responses',
          {
            model: openAiModel,
            input: 'Reply with OK',
            max_output_tokens: 16,
            store: false,
          },
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: 15000,
          },
        );
      } else if (normalizedProvider.includes('gemini')) {
        const geminiModel = String(model || 'gemini-2.5-flash')
          .trim()
          .replace(/^models\//, '');

        await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
            geminiModel,
          )}:generateContent`,
          {
            contents: [
              {
                parts: [{ text: 'Reply with OK' }],
              },
            ],
            generationConfig: {
              maxOutputTokens: 16,
            },
          },
          {
            params: {
              key: apiKey,
            },
            timeout: 15000,
          },
        );
      } else {
        return {
          success: false,
          message: `Unsupported provider: ${provider}`,
        };
      }

      return {
        success: true,
        message: 'Connection successful. API key is valid.',
      };
    } catch (error) {
      const axiosError = error as AxiosError<any>;

      const statusCode = axiosError.response?.status;
      const errorData = axiosError.response?.data;

      const providerError =
        errorData?.error?.message ||
        errorData?.message ||
        axiosError.message ||
        'Provider connection failed';

      const errorCode =
        errorData?.error?.code ||
        errorData?.error?.type ||
        errorData?.code;

      return {
        success: false,
        statusCode,
        errorCode,
        message: errorCode
          ? `${errorCode}: ${providerError}`
          : providerError,
      };
    }
  }
}

export default new AIAgentService();

/** Extract readable text from stored WhatsApp payloads; media gets a type label, not transcription. */
export function assistantMessageText(row: any): string {
  let content = row.content;
  if (typeof content === 'string') {
    try { content = JSON.parse(content); } catch { return content; }
  }
  const text = content?.text?.body || (typeof content?.text === 'string' ? content.text : '')
    || content?.body || content?.interactive?.button_reply?.title || content?.interactive?.list_reply?.title
    || content?.button?.text || content?.caption || content?.image?.caption || content?.video?.caption
    || content?.interactive?.body?.text;
  return typeof text === 'string' ? text : `[${row.type || 'non-text'} message]`;
}
