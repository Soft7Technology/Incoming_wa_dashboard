import { Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { AuthRequest } from '@surefy/middleware/auth.middleware';
import aiAssistantModel from '../../models/aiAssistant.model';
import { encryptApiKey, decryptApiKey, maskApiKey } from '../../utils/crypto.util';
import { extractTextFromFile } from '../../utils/fileExtractor.util';
import axios from 'axios';
import fs from 'fs';

const formatResponse = (assistant: any) => {
  if (!assistant) return null;
  return {
    id: Number(assistant.id),
    name: assistant.name,
    role: assistant.role,
    status: assistant.status,
    promptType: assistant.prompt_type,
    predefinedPrompt: assistant.predefined_prompt,
    customPrompt: assistant.custom_prompt,
    provider: assistant.provider,
    model: assistant.model,
    apiKey: assistant.api_key ? maskApiKey(decryptApiKey(assistant.api_key)) : null,
    createdAt: assistant.created_at,
    updatedAt: assistant.updated_at,
  };
};

class AIAssistantController {
  getAssistants = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const userId = req.userId!;
    const assistants = await aiAssistantModel.findByUserId(userId);
    const formatted = assistants.map(formatResponse);
    return successResponse(req, res, 'Assistants retrieved successfully', formatted);
  });

  createAssistant = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const userId = req.userId!;
    const { name, role, status, promptType, predefinedPrompt, customPrompt, provider, model, apiKey } = req.body;

    console.log("createAssistant headers:", req.headers);
    console.log("createAssistant body:", req.body);
    console.log("createAssistant files:", req.files);
    if (!name || !role || !promptType || !provider || !model) {
      throw new HTTP400Error({ message: 'Missing required parameters' });
    }

    const payload = {
      user_id: userId,
      name,
      role,
      status: status || 'ACTIVE',
      prompt_type: promptType,
      predefined_prompt: predefinedPrompt || null,
      custom_prompt: customPrompt || null,
      provider,
      model,
      api_key: encryptApiKey(apiKey) || undefined,
    };

    const result = await aiAssistantModel.createAssistant(payload);
    const assistantId = result.id;

    // Process uploaded files if any
    if (req.files && Array.isArray(req.files) && req.files.length > 0) {
      for (const file of req.files) {
        const ext = file.originalname.split('.').pop()?.toLowerCase() || '';
        const extractedText = await extractTextFromFile(file.path, ext);

        await aiAssistantModel.insertKnowledgeFile({
          ai_assistant_id: Number(assistantId),
          file_name: file.originalname,
          file_type: ext,
          file_path: file.path,
          extracted_text: extractedText,
        });
      }
    }

    return successResponse(req, res, 'Assistant created successfully', formatResponse(result));
  });

  updateAssistant = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const { name, role, status, promptType, predefinedPrompt, customPrompt, provider, model, apiKey } = req.body;

    const existing = await aiAssistantModel.findById(id);
    if (!existing) {
      throw new HTTP400Error({ message: 'Assistant not found' });
    }

    let finalApiKey = existing.api_key || undefined;
    if (apiKey && !apiKey.includes('***')) {
      finalApiKey = encryptApiKey(apiKey) || undefined;
    }

    const payload = {
      name: name ?? existing.name,
      role: role ?? existing.role,
      status: status ?? existing.status,
      prompt_type: promptType ?? existing.prompt_type,
      predefined_prompt: predefinedPrompt !== undefined ? predefinedPrompt : existing.predefined_prompt,
      custom_prompt: customPrompt !== undefined ? customPrompt : existing.custom_prompt,
      provider: provider ?? existing.provider,
      model: model ?? existing.model,
      api_key: finalApiKey,
      updated_at: new Date().toISOString(),
    };

    const result = await aiAssistantModel.updateAssistant(id, payload);

    // Process uploaded files if any
    if (req.files && Array.isArray(req.files) && req.files.length > 0) {
      for (const file of req.files) {
        const ext = file.originalname.split('.').pop()?.toLowerCase() || '';
        const extractedText = await extractTextFromFile(file.path, ext);

        await aiAssistantModel.insertKnowledgeFile({
          ai_assistant_id: Number(id),
          file_name: file.originalname,
          file_type: ext,
          file_path: file.path,
          extracted_text: extractedText,
        });
      }
    }

    return successResponse(req, res, 'Assistant updated successfully', formatResponse(result));
  });

  deleteAssistant = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const existing = await aiAssistantModel.findById(id);
    if (!existing) {       
      throw new HTTP400Error({ message: 'Assistant not found' });
    }

    await aiAssistantModel.deleteAssistant(id);
    return successResponse(req, res, 'Assistant deleted successfully', { id: Number(id) });
  });

  testConnection = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { provider, model, apiKey, assistantId } = req.body;
    let keyToTest = apiKey;
    
    // If the frontend sends the masked key back, treat it as empty so we fetch from DB
    if (keyToTest && keyToTest.includes('***')) {
      keyToTest = undefined;
    }

    if (!keyToTest && assistantId) {
      const existing = await aiAssistantModel.findById(assistantId);
      if (existing && existing.api_key) {
        const decrypted = decryptApiKey(existing.api_key);
        if (decrypted && decrypted.includes('***')) {
          throw new HTTP400Error({ message: 'Saved API Key is corrupted (masked). Please enter your real API key and save again.' });
        }
        keyToTest = decrypted;
      }
    }

    if (!keyToTest) {
      throw new HTTP400Error({ message: 'API Key is missing' });
    }

    try {
      if (provider.toLowerCase().includes('openai')) {
        await axios.post(
          'https://api.openai.com/v1/chat/completions',
          { model: model || 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }], max_tokens: 1 },
          { headers: { Authorization: `Bearer ${keyToTest}` } }
        );
      } else if (provider.toLowerCase().includes('gemini')) {
        const geminiModel = model?.toLowerCase().includes('pro') ? 'gemini-pro-latest' : 'gemini-flash-latest';
        await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${keyToTest}`,
          { contents: [{ parts: [{ text: 'hello' }] }] }
        );
      } else {
        throw new HTTP400Error({ message: 'Unsupported provider for testing' });
      }
      return successResponse(req, res, 'Connection successful. API Key is valid.');
    } catch (error: any) {
      const msg = error?.response?.data?.error?.message || error?.message || 'Invalid API Key';
      throw new HTTP400Error({ message: `Connection failed: ${msg}` });
    }
  });
}

export default new AIAssistantController();
