import type { Router } from 'express';

/** Express 4 does not forward rejected handler promises to its error middleware. */
export function protectAsyncRoutes(router: Router): void {
  const visited = new WeakSet<object>();
  const wrapped = new WeakSet<Function>();
  const visit = (stack: any[]) => {
    if (visited.has(stack)) return;
    visited.add(stack);
    for (const layer of stack) {
      if (layer.route?.stack) { visit(layer.route.stack); continue; }
      if (layer.handle?.stack) { visit(layer.handle.stack); continue; }
      const handler = layer.handle;
      if (typeof handler !== 'function' || wrapped.has(handler)) continue;
      // Keep error-handler arity: Express distinguishes four arguments from three.
      const safe = handler.length === 4
        ? function(this: unknown, error: any, req: any, res: any, next: any) {
          return Promise.resolve().then(() => handler.call(this, error, req, res, next)).catch(next);
        }
        : function(this: unknown, req: any, res: any, next: any) {
          return Promise.resolve().then(() => handler.call(this, req, res, next)).catch(next);
        };
      wrapped.add(safe);
      layer.handle = safe;
    }
  };
  visit((router as any).stack || (router as any)._router?.stack || []);
}
