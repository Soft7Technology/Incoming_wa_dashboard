/**
 * Emits socket events to WA_Dashboard's Socket.IO server via a direct
 * HTTP call to the internal /internal/socket-emit endpoint.
 * This avoids any Redis pub/sub complexity.
 */

// WA_Dashboard runs on port 3000 locally
const WA_DASHBOARD_SOCKET_EMIT_URL =
  process.env.WA_DASHBOARD_INTERNAL_URL ||
  "http://localhost:3000/internal/socket-emit";

export async function publishSocketEvent(
  event: string,
  data: Record<string, unknown>
): Promise<void> {
  try {
    const res = await fetch(WA_DASHBOARD_SOCKET_EMIT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, data }),
    });
    if (res.ok) {
      console.log(`[SocketBridge] ✅ Emitted ${event} via HTTP`);
    } else {
      console.warn(`[SocketBridge] ⚠️ HTTP emit returned ${res.status}`);
    }
  } catch (err) {
    console.error("[SocketBridge] ❌ Failed to emit via HTTP:", err);
  }
}
