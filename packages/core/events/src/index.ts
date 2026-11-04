// 🟡 最小 events (agent-e 2026-07-29)
type Handler = (event: any) => void;
class EventBus {
  private handlers: Map<string, Handler[]> = new Map();
  on(type: string, handler: Handler) { if (!this.handlers.has(type)) this.handlers.set(type, []); this.handlers.get(type)!.push(handler); }
  off(type: string, handler: Handler) { const h = this.handlers.get(type); if (h) { const i = h.indexOf(handler); if (i >= 0) h.splice(i, 1); } }
  emit(type: string, event: any) { const h = this.handlers.get(type); if (h) h.forEach(fn => { try { fn(event); } catch {} }); }
  publish(event: any) { this.emit(event.type || 'unknown', event); }
}
export const bus = new EventBus();
export default bus;
