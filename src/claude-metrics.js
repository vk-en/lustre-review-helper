'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

// Only local review children receive this endpoint. No prompts or raw telemetry
// are retained; keep numeric cost counters, keyed by the client's session id.
async function startClaudeMetrics() {
  const route = `/${crypto.randomBytes(24).toString('hex')}/v1/metrics`;
  const sessions = new Map();
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== route || req.headers.origin) {
      res.writeHead(404); res.end(); req.resume(); return;
    }
    let size = 0;
    const chunks = [];
    req.on('error', () => {});
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) { res.writeHead(413); res.end(); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        for (const resource of data.resourceMetrics || []) for (const scope of resource.scopeMetrics || []) {
          for (const metric of scope.metrics || []) {
            if (metric.name !== 'claude_code.cost.usage' || ![2, 'AGGREGATION_TEMPORALITY_CUMULATIVE'].includes(metric.sum?.aggregationTemporality)) continue;
            for (const point of metric.sum.dataPoints || []) {
              const attributes = Object.fromEntries((point.attributes || []).map(a => [a.key, a.value?.stringValue]));
              const sessionId = attributes['session.id'];
              const value = Number(point.asDouble ?? point.asInt);
              if (!/^[a-f0-9-]{36}$/.test(sessionId) || !Number.isFinite(value) || value < 0) continue;
              let counters = sessions.get(sessionId);
              if (!counters) {
                if (sessions.size >= 1000) continue;
                sessions.set(sessionId, counters = new Map());
              }
              // Preserve distinct attribution dimensions without retaining identity attributes.
              const key = crypto.createHash('sha256').update(JSON.stringify([
                resource.resource?.attributes, [...(point.attributes || [])].sort((a, b) => a.key.localeCompare(b.key)), point.startTimeUnixNano,
              ])).digest('hex');
              const previous = counters.get(key);
              const time = BigInt(point.timeUnixNano || 0);
              if (!previous || time >= previous.time) {
                if (counters.size < 10000 || previous) counters.set(key, { value, time });
              }
            }
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
      } catch { res.writeHead(400); res.end(); }
    });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  server.unref();
  return {
    env: {
      CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `http://127.0.0.1:${server.address().port}${route}`,
      OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'CUMULATIVE',
      OTEL_METRIC_EXPORT_INTERVAL: '1000', OTEL_METRICS_INCLUDE_SESSION_ID: 'true',
      OTEL_METRICS_INCLUDE_ACCOUNT_UUID: 'false',
      OTEL_EXPORTER_OTLP_HEADERS: '', OTEL_EXPORTER_OTLP_METRICS_HEADERS: '',
      OTEL_LOGS_EXPORTER: 'none', OTEL_TRACES_EXPORTER: 'none',
    },
    cost(sessionId) {
      const counters = sessions.get(sessionId);
      return counters?.size ? [...counters.values()].reduce((total, point) => total + point.value, 0) : null;
    },
    dispose: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }),
  };
}

module.exports = { startClaudeMetrics };
