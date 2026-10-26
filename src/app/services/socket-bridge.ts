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
  const secret = process.env.SOCKET_EMIT_SECRET;
  if (!secret || secret.length < 32) {
    console.warn('[SocketBridge] Event skipped: SOCKET_EMIT_SECRET is not configured');
    return;
  }
  try {
    const res = await fetch(WA_DASHBOARD_SOCKET_EMIT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Socket-Emit-Key": secret },
      body: JSON.stringify({ event, data }),
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      console.log(`[SocketBridge] ✅ Emitted ${event} via HTTP`);
    } else {
      console.warn(`[SocketBridge] ⚠️ HTTP emit returned ${res.status}`);
    }
  } catch (err) {
    console.error('[SocketBridge] HTTP notification failed:', err instanceof Error ? err.name : 'Error');
  }
}
