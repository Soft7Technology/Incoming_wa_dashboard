import { Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { AuthRequest } from '@surefy/middleware/auth.middleware';
import aiAssistantModel from '../../models/aiAssistant.model';
import { encryptApiKey, decryptApiKey} from '../../utils/crypto.util';
import aiAgentService from '../../services/aiAssistant.service';


export const openAiModelMap: Record<string, string> = {
  'gpt-4o': 'gpt-4o',
  'gpt-4o mini': 'gpt-4o-mini',
  'gpt-4.1': 'gpt-4.1',
  'gpt-4.1 mini': 'gpt-4.1-mini',
};

class AIAssistantController {
  getAssistants = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const userId = req.userId!;
    const assistants = await aiAssistantModel.findByUserId(userId);
    return successResponse(req, res, 'Assistants retrieved successfully', assistants);
  });

  createAssistant = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const userId = req.userId!;

    const {
      name,
      role,
      promptType,
      predefinedPrompt,
      customPrompt,
      provider,
      model,
      apiKey,
    } = req.body;

    if (!name || !role || !promptType || !provider || !model || !apiKey) {
      throw new HTTP400Error({
        message: 'Missing required parameters',
      });
    }

    let connectionVerified = false;
    let connectionError: string | null = null;

    try {
      await aiAgentService.testProviderConnection(
        provider,
        model,
        apiKey,
      );

      connectionVerified = true;
    } catch (error: any) {
      connectionVerified = false;

      const rawConnectionError =
        error?.response?.data?.error?.message ||
        error?.response?.data?.message ||
        error?.message ||
        'Unable to verify provider connection';

      connectionError = String(rawConnectionError).slice(0, 500);

      console.error('AI provider connection failed:', {
        provider,
        model,
        error: connectionError,
      });
    }

    const encryptedApiKey = encryptApiKey(apiKey);

    if (!encryptedApiKey) {
      throw new HTTP400Error({
        message: 'Unable to encrypt API key',
      });
    }

    const payload = {
      user_id: userId,
      name,
      role,
      status: connectionVerified
        ? ('ACTIVE' as const)
        : ('INACTIVE' as const),
      prompt_type: promptType,
      predefined_prompt: predefinedPrompt || null,
      custom_prompt: customPrompt || null,
      provider,
      model,
      connection_verified: connectionVerified,
      connection_error: connectionError,
      api_key: encryptedApiKey,
    };

    const response = await aiAssistantModel.create(payload);

    const message = connectionVerified
      ? 'Assistant created and connection verified successfully'
      : `Assistant created, but provider connection failed: ${connectionError || 'Unknown connection error'
      }`;

    return successResponse(
      req,
      res,
      message,
      response
    );
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

    const result = await aiAssistantModel.update(id, payload);

    return successResponse(req, res, 'Assistant updated successfully', result);
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

  testConnection = tryCatchAsync(
    async (req: AuthRequest, res: Response) => {
      const {
        provider,
        model,
        apiKey,
        assistantId,
      } = req.body;

      if (!provider) {
        throw new HTTP400Error({
          message: 'Provider is required',
        });
      }

      let keyToTest = String(apiKey || '').trim();

      // Use the saved encrypted key when frontend sends a masked/empty key
      if ((!keyToTest || keyToTest.includes('***')) && assistantId) {
        const existing = await aiAssistantModel.findById(assistantId);

        if (existing?.api_key) {
          keyToTest = decryptApiKey(existing.api_key)?.trim() || '';
        }
      }

      if (!keyToTest || keyToTest.includes('***')) {
        throw new HTTP400Error({
          message: 'API key is missing or invalid',
        });
      }

      const testResult =
        await aiAgentService.testProviderConnection(
          provider,
          model,
          keyToTest,
        );

      // Update database when testing an existing assistant
      if (assistantId) {
        await aiAssistantModel.update(assistantId, {
          status: testResult.success ? 'ACTIVE' : 'INACTIVE',
          connection_error: testResult.success
            ? null
            : testResult.message,
          last_connection_test_at: new Date(),
        });
      }

      if (!testResult.success) {
        throw new HTTP400Error({
          message: testResult.message,
        });
      }

      return successResponse(
        req,
        res,
        testResult.message,
        {
          assistantId,
          status: 'ACTIVE',
        },
      );
    },
  );
}

export default new AIAssistantController();
