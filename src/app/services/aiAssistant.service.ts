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
   * Run the AI Assistant for a given message
   */
  async runAssistant(userId: string, companyId: string, phone: string, incomingText: string): Promise<string | null> {
    try {
      // 1. Get the active assistant for the user
      const assistants = await aiAssistantModel.findByUserId(userId);
      const activeAssistant = assistants.find((a: any) => a.status === 'ACTIVE');

      if (!activeAssistant) {
        console.log(`⚠️ No active AI Assistant found for user ${userId}`);
        return null;
      }

      // 2. Fetch recent chat history to provide context/memory (limit to last 10 messages)
      const history = await messageModel.getRecentMessages(userId, phone, 10);

      history.reverse(); // Order from oldest to newest

      // 3. Format prompt and system instruction
      let systemInstruction = activeAssistant.prompt_type === 'custom'
        ? activeAssistant.custom_prompt
        : `You are a helpful assistant acting as a: ${activeAssistant.role}.`;



      const provider = activeAssistant.provider.toLowerCase();
      const apiKey = decryptApiKey(activeAssistant.api_key) || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;

      if (!apiKey) {
        console.warn('⚠️ No API Key found for AI Assistant.');
        return 'Assistant configuration error: API Key not found.';
      }

      let responseText = '';

      if (provider.includes('gemini')) {
        // Call Gemini API via Axios
        const modelName = activeAssistant.model.toLowerCase().includes('pro') ? 'gemini-1.5-pro' : 'gemini-1.5-flash';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

        // Format history for Gemini
        const contents = history.map((msg: any) => ({
          role: msg.direction === 'inbound' ? 'user' : 'model',
          parts: [{ text: msg.content?.body || '' }]
        }));

        // Append latest incoming text
        contents.push({
          role: 'user',
          parts: [{ text: incomingText }]
        });

        const payload = {
          contents,
          systemInstruction: {
            parts: [{ text: systemInstruction || '' }]
          }
        };

        const res = await axios.post(url, payload, {
          headers: { 'Content-Type': 'application/json' }
        });

        responseText = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

      } else if (provider.includes('openai')) {
        // Call OpenAI API via Axios
        const url = 'https://api.openai.com/v1/chat/completions';
        const modelName = activeAssistant.model.toLowerCase().includes('mini') ? 'gpt-4o-mini' : 'gpt-4o';

        // Format history for OpenAI
        const messages: any[] = [
          { role: 'system', content: systemInstruction || '' }
        ];

        history.forEach((msg: any) => {
          messages.push({
            role: msg.direction === 'inbound' ? 'user' : 'assistant',
            content: msg.content?.body || ''
          });
        });

        messages.push({
          role: 'user',
          content: incomingText
        });

        const payload = {
          model: modelName,
          messages,
          temperature: 0.7
        };

        const res = await axios.post(url, payload, {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          }
        });

        responseText = res.data?.choices?.[0]?.message?.content || '';
      }

      return responseText.trim();

    } catch (error: any) {
      console.error('❌ AI Agent Service Error:', error?.response?.data || error.message);
      return 'Sorry, I encountered an issue processing your request.';
    }
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
