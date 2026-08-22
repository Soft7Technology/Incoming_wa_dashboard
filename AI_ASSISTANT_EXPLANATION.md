# AI Assistant Module Architecture

This document explains the technical flow and logic for the **AI Assistant** module in the backend (`Incoming_wa_dashboard`).

## 1. Overview
The AI Assistant module acts as an intelligent auto-responder for incoming WhatsApp messages. It connects to third-party LLM providers (Google Gemini, OpenAI) and retains recent chat history to reply contextually.

### Core Files
1. **`src/app/models/aiAssistant.model.ts`**: Handles DB queries for creating, updating, and fetching user's AI configurations from the database.
2. **`src/app/http/controllers/aiAssistant.controller.ts`**: The API controller. Manages CRUD operations from the frontend dashboard (e.g., adding a prompt, setting the model).
3. **`src/app/services/aiAgent.service.ts`**: The core execution engine. Takes an incoming WhatsApp message and queries the LLM to get an intelligent response.
4. **`src/routes/aiAssistant.route.ts`**: The REST API endpoints map for frontend dashboard interactions.

*(Note: The 'Knowledge Base' feature, which used to parse files and append them to the AI's memory, has been recently removed to simplify the architecture.)*

---

## 2. Setting Up an Assistant (The Controller)

When a user configures their AI Assistant on the frontend, a `POST` or `PUT` request is sent to `aiAssistant.route.ts`.

- **Encryption**: If the user provides a custom `API_KEY` for OpenAI/Gemini, it is securely encrypted before being saved using `encryptApiKey()` (`crypto.util.ts`).
- **Fields saved**: 
  - `role`: The persona of the bot (e.g., "Customer Support").
  - `prompt_type`: "custom" or "predefined".
  - `custom_prompt`: Detailed instructions.
  - `provider` & `model`: e.g., "gemini" -> "gemini-1.5-pro".
  - `status`: "ACTIVE" or "INACTIVE".

---

## 3. How the Bot Replies (The Execution Flow)

The magic happens in `AIAgentService.runAssistant()` whenever an incoming message is received from the Meta Webhook.

### Step-by-Step Flow:

1. **Assistant Lookup:**
   - The service queries the DB to find if the user has an `ACTIVE` assistant.
   - If no active assistant is found, the flow terminates gracefully, and no AI response is generated.

2. **Context / Memory Retrieval:**
   - The bot needs to remember what was just said. It fetches the last `10` messages between the user and this specific WhatsApp phone number (`messageModel.getRecentMessages`).
   - The messages are ordered chronologically so the LLM understands the conversation flow.

3. **Building the System Prompt (`systemInstruction`):**
   - If the user selected `prompt_type === 'custom'`, it uses their exact `custom_prompt`.
   - Otherwise, it falls back to a predefined string: `"You are a helpful assistant acting as a: {role}."`

4. **API Key Decryption & Fallback:**
   - The service decrypts the user's specific API key stored in the DB.
   - If the user didn't provide one, it gracefully falls back to the system's global environment variables (`process.env.GEMINI_API_KEY` or `process.env.OPENAI_API_KEY`).

5. **LLM Execution (Gemini vs OpenAI):**
   - **Gemini Engine (`generativelanguage.googleapis.com`):**
     - Formats history into `{ role: 'user' | 'model', parts: [{text}] }`.
     - Maps 'pro' to `gemini-1.5-pro` and everything else to `gemini-1.5-flash`.
   - **OpenAI Engine (`api.openai.com`):**
     - Formats history into `{ role: 'user' | 'assistant', content }`.
     - Maps 'mini' to `gpt-4o-mini` and everything else to `gpt-4o`.
   - The HTTP request is made directly using `axios` to avoid heavy SDK dependencies.

6. **Response Extraction & Return:**
   - The JSON response from Gemini/OpenAI is parsed.
   - The `responseText` is extracted, `.trim()`ed, and returned to the webhook handler.
   - The webhook handler then dispatches this text back to the WhatsApp user via the Meta API.

---

## 4. Error Handling
If the LLM provider fails (e.g., API limit reached, invalid key), a generic fallback message is returned: *"Sorry, I encountered an issue processing your request."* This prevents the app from crashing and keeps the user informed.
