/**
 * Pure request/response router. It intentionally has no DOM dependencies so the
 * exact same implementation can run in Node tests and in the injected renderer.
 */
export function createRendererMessageRouter({
  onEvent = () => {},
  onProtocolError = () => {},
  timeoutMs = 30_000,
} = {}) {
  let nextId = 0;
  let disposed = false;
  const pending = new Map();

  function request(method, params, send) {
    if (disposed) return Promise.reject(new Error("Renderer bridge is disposed"));
    if (typeof method !== "string" || method.length === 0) {
      return Promise.reject(new TypeError("Bridge method must be a non-empty string"));
    }
    if (typeof send !== "function") {
      return Promise.reject(new TypeError("Bridge send callback is required"));
    }

    const id = String(++nextId);
    return new Promise((resolve, reject) => {
      let timer;
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Host request timed out: ${method}`));
        }, timeoutMs);
      }
      pending.set(id, { resolve, reject, timer, method });

      try {
        send(JSON.stringify({ kind: "request", id, method, params: params ?? {} }));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  function route(rawMessage) {
    let message = rawMessage;
    if (typeof rawMessage === "string") {
      try {
        message = JSON.parse(rawMessage);
      } catch (error) {
        onProtocolError(error, rawMessage);
        return false;
      }
    }

    if (!message || typeof message !== "object") {
      onProtocolError(new Error("Host message must be an object"), rawMessage);
      return false;
    }

    if (message.kind === "response") {
      const entry = pending.get(String(message.id));
      if (!entry) return false;
      pending.delete(String(message.id));
      clearTimeout(entry.timer);

      if (message.ok === false) {
        const error = new Error(message.error?.message ?? `Host request failed: ${entry.method}`);
        error.name = message.error?.name ?? "HostRequestError";
        error.code = message.error?.code;
        error.data = message.error?.data;
        entry.reject(error);
      } else {
        entry.resolve(message.result);
      }
      return true;
    }

    if (message.kind === "event") {
      onEvent(message.event);
      return true;
    }

    onProtocolError(new Error(`Unknown host message kind: ${String(message.kind)}`), message);
    return false;
  }

  function dispose(reason = "Renderer bridge disposed") {
    if (disposed) return;
    disposed = true;
    const error = new Error(reason);
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  return {
    request,
    route,
    dispose,
    get pendingCount() {
      return pending.size;
    },
  };
}
