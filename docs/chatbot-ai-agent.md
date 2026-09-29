# WhatsApp AI-agent node

Use `data.key: "@whatsapp/ai-agent"` with `data.attributes.assistantId` set to an existing active assistant belonging to the flow/receiving-phone owner. The value is the local `ai_assistants.id`, not an OpenAI hosted Assistant ID. The repository's original schema uses numeric IDs; UUID IDs work only on deployments whose assistant schema uses UUIDs. The sample UUID must identify a real record in that deployment.

The existing assistant's `provider`, `model`, encrypted `api_key`, and custom/predefined prompt are used. No platform environment API-key fallback is used. OpenAI and Gemini are supported through the existing service. The OpenAI request follows the [official Chat Completions API](https://developers.openai.com/api/reference/resources/chat).

On entry and each follow-up message, the node fetches at most ten received/sent/delivered/read messages for the exact company, account owner, receiving business number, and international customer number. It sends those messages oldest-first after the configured prompt. The current inbound message has already been saved by the webhook and is not appended twice. Failed/queued messages are excluded. Media without textual content is represented by a type label; this does not perform image understanding or audio transcription.

Generated replies use the existing chatbot send service and are persisted in `messages`, becoming context for subsequent replies. A nonempty `welcomeMessage` is sent once upon entry before the generated response. `data.dataOut.variable`, if provided, stores the last response in session variables.

The session remains on the AI node. Whole-message, case-insensitive `stopKeywords` (such as `/stop`) exits the node. A positive `timeout` accepts `seconds`, `minutes`, or `hours` and defaults to five minutes. Inactivity expiration is checked on the next inbound message; there is no background timeout notification. On expiration, `timeoutMessage` is sent if configured. Stop/timeout follows the outgoing edge, or ends the session if none exists. Existing keyword-trigger routing still takes precedence over an active session.

Assistant/provider errors produce a generic retry message without exposing the API key or provider request details. Provider calls time out after 30 seconds. The tests mock provider HTTP; no paid API request or live WhatsApp send was made. No schema migration is required.
