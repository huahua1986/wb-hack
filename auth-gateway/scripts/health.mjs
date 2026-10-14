import { readConfig } from '../src/config.mjs';
import { get } from 'node:http';
try {
  const config = readConfig();
  const body = await new Promise((resolve, reject) => {
    const request = get({ hostname: '127.0.0.1', port: config.port, path: '/healthz', headers: { Host: new URL(config.publicUrl).host }, signal: AbortSignal.timeout(3000) }, response => {
      let text = ''; response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; if (text.length > 65536) request.destroy(new Error('Health response is too large')); });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const value = JSON.parse(text);
          if (response.statusCode !== 200 || value.data?.status !== 'ok' || value.data?.service !== 'workbuddy-auth') throw new Error('Authentication backend is not ready');
          resolve(value);
        } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
  });
  console.log(JSON.stringify({ status: 'ok', schema: body.data.schema }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
