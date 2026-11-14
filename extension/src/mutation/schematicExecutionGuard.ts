import { apiError } from "../helpers.js";
import { assertDocumentTargetMatch, extractDocumentIdentity, type DocumentIdentity } from "../identity.js";
import type { EasyEdaApi } from "../types.js";

/** A deadline ends executor awaits, not native work; no subsequent writes may start after expiry. */
export function guardedSchematicApi(api: () => EasyEdaApi, target: DocumentIdentity, budgetMs = 40000) {
  const deadline = Date.now() + budgetMs;
  const ensure = () => {
    if (Date.now() >= deadline)
      throw apiError("execution_budget_expired", "Schematic execution budget expired; no further writes started.");
  };
  async function bounded<T>(run: () => Promise<T> | T): Promise<T> {
    ensure();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(run),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                apiError(
                  "execution_budget_expired",
                  "Schematic native call exceeded execution deadline; no further writes started."
                )
              ),
            Math.max(1, deadline - Date.now())
          );
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const guard = async () => {
    ensure();
    const info = await bounded(() => api().dmt_SelectControl.getCurrentDocumentInfo());
    assertDocumentTargetMatch(target, extractDocumentIdentity(info));
    ensure();
  };
  const owners = new Map<string, any>();
  const root = new Proxy(api(), {
    get(object, key: string) {
      const owner = object[key];
      if (!owner || typeof owner !== "object") return owner;
      if (!owners.has(key))
        owners.set(
          key,
          new Proxy(owner, {
            get(service, method: string) {
              const fn = service[method];
              if (typeof fn !== "function") return fn;
              return async (...args: any[]) => {
                const writing = /^sch_/.test(key) && ["modify", "create", "delete"].includes(method);
                if (writing) await guard();
                const result = await bounded(() => fn.apply(service, args));
                ensure();
                return result;
              };
            }
          })
        );
      return owners.get(key);
    }
  });
  return { api: () => root, guard, ensure, deadline, bounded };
}
