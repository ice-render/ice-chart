/** 极简类型化事件发射器：图表对外的事件接口由它承载。 */

export type Listener = (payload: any) => void;

export class Emitter {
  private listeners: Map<string, Array<{ fn: Listener; scope: any }>> = new Map();

  public on(event: string, fn: Listener, scope: any = null): this {
    const arr = this.listeners.get(event) || [];
    this.off(event, fn, scope);
    arr.push({ fn, scope });
    this.listeners.set(event, arr);
    return this;
  }

  public once(event: string, fn: Listener, scope: any = null): this {
    const wrapper = (payload: any) => {
      this.off(event, wrapper, scope);
      fn.call(scope, payload);
    };
    (wrapper as any).__onceOriginal = fn;
    return this.on(event, wrapper, scope);
  }

  public off(event: string, fn?: Listener, scope?: any): this {
    const arr = this.listeners.get(event);
    if (!arr) return this;
    if (!fn) {
      this.listeners.delete(event);
      return this;
    }
    for (let i = arr.length - 1; i >= 0; i--) {
      const item = arr[i];
      const cb: any = item.fn;
      const matched = cb === fn || (cb && cb.__onceOriginal === fn);
      if (matched && (scope === undefined || item.scope === scope)) {
        arr.splice(i, 1);
      }
    }
    if (!arr.length) this.listeners.delete(event);
    return this;
  }

  public emit(event: string, payload?: any): boolean {
    const arr = this.listeners.get(event);
    if (!arr || !arr.length) return false;
    const copy = arr.slice();
    for (let i = 0; i < copy.length; i++) {
      copy[i].fn.call(copy[i].scope, payload);
    }
    return true;
  }

  public hasListener(event: string): boolean {
    const arr = this.listeners.get(event);
    return !!arr && arr.length > 0;
  }

  public clear(): void {
    this.listeners.clear();
  }
}
