export async function get(path: string) { return fetch(path).then((r) => r.json()); }
