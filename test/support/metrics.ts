import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/**
 * The value of a Prometheus sample in `GET /metrics`, e.g.
 * `metricValue(app, 'aisits_telemetry_device_messages_total', { outcome: 'accepted' })`;
 * `0` when the series has not been observed yet. Labels must be given in the
 * order prom-client renders them (declaration order).
 */
export async function metricValue(
  app: NestFastifyApplication,
  name: string,
  labels: Readonly<Record<string, string>> = {},
): Promise<number> {
  const response = await app.inject({ method: 'GET', url: '/metrics' });
  const rendered = Object.entries(labels)
    .map(([key, value]) => `${key}="${value}"`)
    .join(',');
  const series = rendered === '' ? name : `${name}{${rendered}}`;
  const line = response.body
    .split('\n')
    .find((candidate) => candidate.startsWith(`${series} `));
  return line === undefined ? 0 : Number(line.slice(series.length + 1));
}
