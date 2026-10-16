import { IncomingMessage, ServerResponse } from 'node:http';

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
) => Promise<void>;

interface Route {
  method: string;
  /** The registered pattern, as written (`/api/tasks/:slug`). */
  path: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: RouteHandler): void {
    const paramNames: string[] = [];
    // `:name` matches a single path segment; `*name` is a rest param that
    // matches across slashes (e.g. `knowledge/data-structures/default`).
    // Single-pass replace keeps param order aligned with capture-group order.
    const pattern = path.replace(/([:*])([a-zA-Z_]+)/g, (_match, kind, name) => {
      paramNames.push(name);
      return kind === '*' ? '(.+)' : '([^/]+)';
    });
    this.routes.push({
      method: method.toUpperCase(),
      path,
      pattern: new RegExp(`^${pattern}$`),
      paramNames,
      handler,
    });
  }

  get(path: string, handler: RouteHandler): void {
    this.add('GET', path, handler);
  }

  post(path: string, handler: RouteHandler): void {
    this.add('POST', path, handler);
  }

  patch(path: string, handler: RouteHandler): void {
    this.add('PATCH', path, handler);
  }

  put(path: string, handler: RouteHandler): void {
    this.add('PUT', path, handler);
  }

  delete(path: string, handler: RouteHandler): void {
    this.add('DELETE', path, handler);
  }

  /** Every registered route, in order (the phone listener's default-deny test walks it). */
  list(): Array<{ method: string; path: string }> {
    return this.routes.map((r) => ({ method: r.method, path: r.path }));
  }

  /** The first route matching `method url` (first match wins), with its registered pattern. */
  match(method: string, url: string): { handler: RouteHandler; params: Record<string, string>; method: string; path: string } | null {
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue;
      const match = url.match(route.pattern);
      if (match) {
        const params: Record<string, string> = {};
        route.paramNames.forEach((name, i) => {
          params[name] = decodeURIComponent(match[i + 1]);
        });
        return { handler: route.handler, params, method: route.method, path: route.path };
      }
    }
    return null;
  }
}
