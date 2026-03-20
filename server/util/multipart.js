export function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/);
    if (!boundaryMatch) return reject(new Error('No boundary in content-type'));
    const boundary = boundaryMatch[1] || boundaryMatch[2];
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const files = [];
      const delimiter = Buffer.from(`--${boundary}`);

      let pos = 0;
      while (pos < buf.length) {
        const start = buf.indexOf(delimiter, pos);
        if (start === -1) break;
        const nextStart = buf.indexOf(delimiter, start + delimiter.length);
        if (nextStart === -1) break;

        const part = buf.subarray(start + delimiter.length, nextStart);
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) { pos = nextStart; continue; }

        const headerStr = part.subarray(0, headerEnd).toString();
        let body = part.subarray(headerEnd + 4);
        if (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
          body = body.subarray(0, body.length - 2);
        }

        const filenameMatch = headerStr.match(/filename="([^"]+)"/);
        const ctMatch = headerStr.match(/Content-Type:\s*(\S+)/i);
        if (filenameMatch) {
          files.push({
            filename: filenameMatch[1],
            mimeType: ctMatch ? ctMatch[1] : 'application/octet-stream',
            data: body,
          });
        }
        pos = nextStart;
      }
      resolve(files);
    });
    req.on('error', reject);
  });
}
