import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { send } from '../util/http.js';

export async function handleTranscribe(req, res) {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const audioBuffer = Buffer.concat(chunks);

    if (audioBuffer.length === 0) return send(res, 400, { error: 'No audio data' });
    if (audioBuffer.length > 25 * 1024 * 1024) return send(res, 400, { error: 'Audio too large (max 25MB)' });

    let apiKey;
    try {
      const ocConfig = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.openclaw', 'openclaw.json'), 'utf8'));
      apiKey = ocConfig?.skills?.entries?.['openai-whisper-api']?.apiKey;
    } catch { /* ok */ }
    if (!apiKey) apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return send(res, 500, { error: 'No OpenAI API key configured' });

    const contentType = req.headers['content-type'] || 'audio/webm';
    const ext = contentType.includes('wav') ? 'wav' : contentType.includes('mp4') || contentType.includes('m4a') ? 'm4a' : contentType.includes('ogg') ? 'ogg' : 'webm';

    const boundary = '----WhisperBoundary' + Date.now();
    const body = Buffer.concat([
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${ext}"\r\nContent-Type: ${contentType}\r\n\r\n`,
      audioBuffer,
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n`,
      `--${boundary}--\r\n`,
    ].map(p => typeof p === 'string' ? Buffer.from(p) : p));

    const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });

    if (!resp.ok) {
      console.error('Whisper API error:', resp.status, await resp.text());
      return send(res, 502, { error: `Whisper API error: ${resp.status}` });
    }
    const result = await resp.json();
    return send(res, 200, { text: result.text || '' });
  } catch (err) {
    console.error('Transcribe error:', err);
    return send(res, 500, { error: err.message });
  }
}
