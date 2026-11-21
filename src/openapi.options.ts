import type { OpenApiOptions } from '@darmawanweb/ais-its-nest';

import { SERVICE } from './service.js';

/** OpenAPI document of the service (`/docs`, `/openapi.json`, `pnpm openapi`). */
export const OPENAPI: OpenApiOptions = {
  title: `AIS Maritime Intelligence — ${SERVICE.title}`,
  version: SERVICE.version,
  description: SERVICE.description,
  tags: [
    {
      name: 'readings',
      description:
        'Fuel readings: ingestion (API keys `telemetry:ingest`, users `telemetry:write`), series, summaries and status',
    },
    {
      name: 'devices',
      description: 'Device registry of an organization (`device:manage`)',
    },
    {
      name: 'methodology',
      description: 'Methods of the methodology catalog implemented here',
    },
  ],
};
