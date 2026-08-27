import { Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { AuthRequest } from '@surefy/middleware/auth.middleware';
import aiAssistantModel from '../../models/aiAssistant.model';

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
    apiKey: assistant.api_key,
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
      api_key: apiKey || null,
    };

    const result = await aiAssistantModel.createAssistant(payload);
    return successResponse(req, res, 'Assistant created successfully', formatResponse(result));
  });

  updateAssistant = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const { name, role, status, promptType, predefinedPrompt, customPrompt, provider, model, apiKey } = req.body;

    const existing = await aiAssistantModel.findById(id);
    if (!existing) {
      throw new HTTP400Error({ message: 'Assistant not found' });
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
      api_key: apiKey !== undefined ? apiKey : existing.api_key,
      updated_at: new Date().toISOString(),
    };

    const result = await aiAssistantModel.updateAssistant(id, payload);
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
}

export default new AIAssistantController();
