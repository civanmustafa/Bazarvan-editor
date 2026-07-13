const readRequestBody = (req: any): Promise<Buffer> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

export const createWebRequest = async (req: any, url: string): Promise<Request> => {
  const headers = new Headers();
  Object.entries(req.headers || {}).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      value.forEach(item => headers.append(key, String(item)));
    } else if (value !== undefined) {
      headers.set(key, String(value));
    }
  });

  const hasBody = req.method && !['GET', 'HEAD'].includes(req.method);
  const body = hasBody ? await readRequestBody(req) : undefined;

  return new Request(url, {
    method: req.method,
    headers,
    body: body && body.length > 0 ? body : undefined,
  });
};

export const sendWebResponse = async (res: any, response: Response): Promise<void> => {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  const body = Buffer.from(await response.arrayBuffer());
  res.end(body);
};
