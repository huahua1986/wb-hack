import { buildRendererSource, DEFAULT_BINDING_NAME, DEFAULT_RENDERER_GLOBAL } from "./renderer/source.js";

export const MAX_RENDERER_BINDING_BYTES = 64 * 1024;
export const MAX_RENDERER_RPC_RESPONSE_BYTES = 1024 * 1024;
export const MAX_RENDERER_RPC_CONCURRENCY = 8;
export const MAX_RENDERER_RPC_TIMEOUT_MS = 120_000;

const RENDERER_RPC_METHODS = new Set([
  "workbuddyMcp.listTools",
  "workbuddyMcp.callTool",
]);

function errorEnvelope(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    code: error?.code,
    data: error?.data,
  };
}

function expressionValue(value) {
  // Double encoding keeps all user-controlled text inside a JavaScript string.
  return `JSON.parse(${JSON.stringify(JSON.stringify(value))})`;
}

export function parseRendererBindingPayload(payload) {
  if (typeof payload !== "string") throw new Error("Renderer binding payload must be a string");
  if (new TextEncoder().encode(payload).byteLength > MAX_RENDERER_BINDING_BYTES) {
    throw new Error("Renderer binding payload exceeds the 64 KiB limit");
  }
  let message;
  try {
    message = JSON.parse(payload);
  } catch {
    throw new Error("Renderer binding payload is not valid JSON");
  }

  if (!message || message.kind !== "request") {
    throw new Error("Renderer binding payload is not a request");
  }
  if ((typeof message.id !== "string" && typeof message.id !== "number") || message.id === "") {
    throw new Error("Renderer request id is missing");
  }
  if (typeof message.method !== "string" || message.method.length === 0) {
    throw new Error("Renderer request method is missing");
  }

  return {
    id: String(message.id),
    method: message.method,
    params: message.params && typeof message.params === "object" ? message.params : {},
  };
}

export class WorkBuddyCdpController {
  #client;
  #bindingName;
  #globalName;
  #rendererSource;
  #requestHandler;
  #subscribe;
  #logger;
  #scriptIdentifier;
  #removeClientListeners = [];
  #unsubscribeHost;
  #disposed = false;
  #installed = false;
  #mainFrameId;
  #contexts = new Map();
  #nextRendererRequestId = 0;
  #rendererRpcInFlight = 0;

  constructor(
    client,
    {
      bindingName = DEFAULT_BINDING_NAME,
      globalName = DEFAULT_RENDERER_GLOBAL,
      rendererSource,
      requestHandler = async ({ method }) => {
        throw new Error(`Unsupported host method: ${method}`);
      },
      subscribe,
      logger,
    } = {},
  ) {
    if (!client || typeof client.request !== "function" || typeof client.on !== "function") {
      throw new TypeError("A CDP client is required");
    }
    if (typeof requestHandler !== "function") throw new TypeError("requestHandler must be a function");

    this.#client = client;
    this.#bindingName = bindingName;
    this.#globalName = globalName;
    this.#rendererSource = rendererSource ?? buildRendererSource({ bindingName, globalName });
    this.#requestHandler = requestHandler;
    this.#subscribe = subscribe;
    this.#logger = logger;
  }

  get installed() {
    return this.#installed;
  }

  get disposed() {
    return this.#disposed;
  }

  async install() {
    if (this.#disposed) throw new Error("CDP controller is disposed");
    if (this.#installed) return this;

    this.#removeClientListeners.push(
      this.#client.on("Runtime.bindingCalled", (params) => void this.#handleBindingCalled(params)),
      this.#client.on("Runtime.executionContextCreated", ({ context }) => {
        if (context?.id != null) this.#contexts.set(context.id, context.auxData ?? {});
      }),
      this.#client.on("Runtime.executionContextDestroyed", ({ executionContextId }) => {
        this.#contexts.delete(executionContextId);
      }),
      this.#client.on("Runtime.executionContextsCleared", () => this.#contexts.clear()),
      this.#client.on("Page.frameNavigated", ({ frame }) => {
        if (frame && !frame.parentId) this.#mainFrameId = frame.id;
      }),
      this.#client.on("close", () => this.#detach()),
    );

    try {
      await this.#client.request("Page.enable");
      const frameTree = await this.#client.request("Page.getFrameTree");
      this.#mainFrameId = frameTree?.frameTree?.frame?.id;
      await this.#client.request("Runtime.enable");

      try {
        await this.#client.request("Runtime.addBinding", { name: this.#bindingName });
      } catch (error) {
        if (!/already|exists|duplicate/i.test(error?.message ?? "")) throw error;
      }

      const registration = await this.#client.request("Page.addScriptToEvaluateOnNewDocument", {
        source: this.#rendererSource,
      });
      this.#scriptIdentifier = registration.identifier;
      await this.#evaluate(this.#rendererSource);

      if (typeof this.#subscribe === "function") {
        this.#unsubscribeHost = await this.#subscribe((event) => {
          void this.emitHostEvent(event).catch((error) => this.#log("warn", error));
        });
      }

      this.#installed = true;
      return this;
    } catch (error) {
      await this.dispose().catch(() => {});
      throw error;
    }
  }

  async emitHostEvent(event) {
    if (this.#disposed) return false;
    await this.#sendToRenderer({ kind: "event", event });
    return true;
  }

  async requestRenderer(method, params = {}, { timeoutMs } = {}) {
    if (this.#disposed) throw new Error("CDP controller is disposed");
    if (!this.#installed) throw new Error("CDP controller is not installed");
    if (!RENDERER_RPC_METHODS.has(method)) {
      throw new Error(`Unsupported renderer RPC method: ${String(method)}`);
    }
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new TypeError("Renderer RPC params must be an object");
    }
    const resolvedTimeoutMs = timeoutMs ?? (
      method === "workbuddyMcp.callTool" ? 35_000 : 10_000
    );
    if (
      !Number.isFinite(resolvedTimeoutMs)
      || resolvedTimeoutMs <= 0
      || resolvedTimeoutMs > MAX_RENDERER_RPC_TIMEOUT_MS
    ) {
      throw new TypeError("Renderer RPC timeout must be between 1 and 120000ms");
    }
    if (this.#rendererRpcInFlight >= MAX_RENDERER_RPC_CONCURRENCY) {
      const error = new Error("Too many WorkBuddy renderer RPC requests are in flight");
      error.code = "WB_RENDERER_RPC_BUSY";
      throw error;
    }

    const request = {
      version: 1,
      id: `renderer-${++this.#nextRendererRequestId}`,
      method,
      params,
    };
    const serialized = JSON.stringify(request);
    if (new TextEncoder().encode(serialized).byteLength > MAX_RENDERER_BINDING_BYTES) {
      const error = new Error("Renderer RPC request exceeds the 64 KiB limit");
      error.code = "WB_RENDERER_RPC_REQUEST_TOO_LARGE";
      throw error;
    }
    const contextId = this.#mainExecutionContextId();
    if (contextId == null) {
      const error = new Error("WorkBuddy main renderer execution context is unavailable");
      error.code = "WB_RENDERER_CONTEXT_UNAVAILABLE";
      throw error;
    }

    const renderer = `globalThis[${JSON.stringify(this.#globalName)}]`;
    const bindingName = JSON.stringify(this.#bindingName);
    const expression = `(async () => {
      const api = ${renderer};
      if (!api || api.bindingName !== ${bindingName} || typeof api.invoke !== "function") {
        throw new Error("WorkBuddy Host renderer was replaced or is unavailable");
      }
      const result = await api.invoke(${expressionValue(request)});
      if (${renderer} !== api || api.bindingName !== ${bindingName}) {
        throw new Error("WorkBuddy Host renderer was replaced during the request");
      }
      return result;
    })()`;

    this.#rendererRpcInFlight += 1;
    try {
      const evaluation = await this.#evaluate(expression, contextId, false, {
        awaitPromise: true,
        timeoutMs: resolvedTimeoutMs,
      });
      const rawEnvelope = evaluation?.result?.value;
      if (typeof rawEnvelope !== "string") {
        throw new Error("WorkBuddy renderer returned no RPC envelope");
      }
      if (new TextEncoder().encode(rawEnvelope).byteLength > MAX_RENDERER_RPC_RESPONSE_BYTES) {
        const error = new Error("Renderer RPC response exceeds the 1 MiB limit");
        error.code = "WB_RENDERER_RPC_RESPONSE_TOO_LARGE";
        throw error;
      }
      let envelope;
      try {
        envelope = JSON.parse(rawEnvelope);
      } catch {
        throw new Error("WorkBuddy renderer returned invalid RPC JSON");
      }
      if (envelope?.version !== 1 || envelope.id !== request.id || typeof envelope.ok !== "boolean") {
        throw new Error("WorkBuddy renderer returned an invalid RPC envelope");
      }
      if (!envelope.ok) {
        const error = new Error(envelope.error?.message ?? `Renderer RPC failed: ${method}`);
        error.name = envelope.error?.name ?? "RendererRpcError";
        error.code = envelope.error?.code;
        throw error;
      }
      return envelope.result;
    } finally {
      this.#rendererRpcInFlight -= 1;
    }
  }

  async dispose({ preserveUiState = false } = {}) {
    if (this.#disposed) return;
    this.#disposed = true;

    if (!this.#client.isClosed) {
      if (this.#scriptIdentifier) {
        await this.#client
          .request("Page.removeScriptToEvaluateOnNewDocument", {
            identifier: this.#scriptIdentifier,
          })
          .catch((error) => this.#log("warn", error));
      }
      await this.#evaluate(
        this.#ownedRendererExpression("dispose", expressionValue({ preserveUiState })),
        undefined,
        true,
      ).catch((error) => this.#log("warn", error));
      await this.#client
        .request("Runtime.removeBinding", { name: this.#bindingName })
        .catch((error) => this.#log("warn", error));
    }

    this.#detach();
  }

  async #handleBindingCalled(params) {
    if (this.#disposed || params?.name !== this.#bindingName) return;
    if (!(await this.#isMainContext(params.executionContextId))) {
      this.#log("warn", new Error("Ignored renderer request from a non-main execution context"));
      return;
    }

    let request;
    try {
      request = parseRendererBindingPayload(params.payload);
    } catch (error) {
      this.#log("warn", error);
      return;
    }

    try {
      const result = await this.#requestHandler(
        { method: request.method, params: request.params, id: request.id },
        { executionContextId: params.executionContextId },
      );
      await this.#sendToRenderer(
        { kind: "response", id: request.id, ok: true, result },
        params.executionContextId,
      );
    } catch (error) {
      await this.#sendToRenderer(
        { kind: "response", id: request.id, ok: false, error: errorEnvelope(error) },
        params.executionContextId,
      ).catch((sendError) => this.#log("warn", sendError));
    }
  }

  async #isMainContext(executionContextId) {
    if (executionContextId == null || !this.#mainFrameId) return false;
    const context = this.#contexts.get(executionContextId);
    if (context) return context.isDefault === true && context.frameId === this.#mainFrameId;

    // Runtime.enable normally replays every context before its response, but a
    // binding can race that notification on some Electron builds. Verify an
    // unknown context in place instead of dropping the first UI request.
    try {
      const renderer = `globalThis[${JSON.stringify(this.#globalName)}]`;
      const evaluation = await this.#client.request("Runtime.evaluate", {
        expression: [
          "globalThis.top === globalThis.self",
          "document.body?.dataset?.applicationName === 'workbuddy'",
          `${renderer}?.bindingName === ${JSON.stringify(this.#bindingName)}`,
        ].join(" && "),
        contextId: executionContextId,
        returnByValue: true,
      });
      return evaluation?.result?.value === true;
    } catch {
      return false;
    }
  }

  async #sendToRenderer(envelope, executionContextId) {
    const expression = this.#ownedRendererExpression("receive", expressionValue(envelope));
    await this.#evaluate(expression, executionContextId);
  }

  #ownedRendererExpression(method, argument) {
    const renderer = `globalThis[${JSON.stringify(this.#globalName)}]`;
    const owned = `${renderer}?.bindingName === ${JSON.stringify(this.#bindingName)}`;
    const invocation = `${renderer}?.${method}?.(${argument ?? ""})`;
    return `${owned} && ${invocation}`;
  }

  #mainExecutionContextId() {
    for (const [contextId, context] of this.#contexts) {
      if (context?.isDefault === true && context.frameId === this.#mainFrameId) return contextId;
    }
    return undefined;
  }

  async #evaluate(
    expression,
    contextId,
    ignoreResult = false,
    { awaitPromise = false, timeoutMs } = {},
  ) {
    const params = {
      expression,
      awaitPromise,
      returnByValue: !ignoreResult,
      userGesture: false,
    };
    if (contextId != null) params.contextId = contextId;

    const requestOptions = timeoutMs === undefined ? undefined : { timeoutMs };
    const result = await this.#client.request("Runtime.evaluate", params, requestOptions);
    if (result?.exceptionDetails) {
      const description =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "Renderer evaluation failed";
      throw new Error(description);
    }
    return result;
  }

  #detach() {
    for (const remove of this.#removeClientListeners.splice(0)) remove?.();
    try {
      this.#unsubscribeHost?.();
    } catch (error) {
      this.#log("warn", error);
    }
    this.#unsubscribeHost = undefined;
    this.#contexts.clear();
    this.#installed = false;
  }

  #log(level, error) {
    const logger = this.#logger;
    if (typeof logger === "function") logger(level, error);
    else if (typeof logger?.[level] === "function") logger[level](error);
  }
}
