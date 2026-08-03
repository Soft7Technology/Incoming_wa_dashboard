import axios from 'axios';
import aiAssistantModel from '../models/aiAssistant.model';
import messageModel from '../models/message.model';

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
      const systemInstruction = activeAssistant.prompt_type === 'custom'                                    
        ? activeAssistant.custom_prompt                                                                                         
        : `You are a helpful assistant acting as a: ${activeAssistant.role}.`;            

      const provider = activeAssistant.provider.toLowerCase();
      const apiKey = activeAssistant.api_key || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;

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
}

export default new AIAgentService();
