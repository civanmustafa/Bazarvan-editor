export type ApiResult = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
};

export const isRecord = (value: unknown): value is Record<string, any> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

export const getHeaderValue = (req: any, headerName: string): string => {
  if (typeof req?.headers?.get === 'function') {
    return req.headers.get(headerName) || '';
  }

  const value = req?.headers?.[headerName.toLowerCase()] ?? req?.headers?.[headerName];
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
};

const readNodeRequestBody = async (req: any): Promise<unknown> => {
  if (req?.body !== undefined) {
    if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
    if (Buffer.isBuffer(req.body)) return req.body.length ? JSON.parse(req.body.toString('utf8')) : {};
    return req.body;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
};

export const readRequestBody = async (req: any): Promise<unknown> => {
  if (typeof req?.json === 'function' && typeof req?.headers?.get === 'function') {
    return req.json();
  }
  return readNodeRequestBody(req);
};

export const toWebResponse = (result: ApiResult): Response => new Response(
  result.status === 204 ? null : JSON.stringify(result.body ?? {}),
  {
    status: result.status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(result.headers || {}),
    },
  },
);

export const sendNodeResponse = (res: any, result: ApiResult): void => {
  res.statusCode = result.status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  Object.entries(result.headers || {}).forEach(([key, value]) => res.setHeader(key, value));
  res.end(result.status === 204 ? undefined : JSON.stringify(result.body ?? {}));
};

export const deliverApiResult = (result: ApiResult, res?: any): Response | void => {
  if (res) {
    sendNodeResponse(res, result);
    return;
  }
  return toWebResponse(result);
};
