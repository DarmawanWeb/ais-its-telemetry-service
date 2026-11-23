import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as z from 'zod';

const PackageJsonSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  /** Human name of the service. */
  displayName: z.string().min(1),
  description: z.string().min(1),
});

/** The service's package.json (next to `src/` and `dist/`). */
function readPackageJson(): z.output<typeof PackageJsonSchema> {
  const url = new URL('../package.json', import.meta.url);
  return PackageJsonSchema.parse(JSON.parse(readFileSync(url, 'utf8')));
}

const packageJson = readPackageJson();

/**
 * Identity of this service (docs/PLATFORM_SPEC.md §1, §3, §6). The defaults
 * of `config.ts`, the OpenAPI document and the telemetry resource use it.
 */
export const SERVICE = Object.freeze({
  /** `SERVICE_NAME`: logs, metrics, event `source`, `audit.v1.<name>`, route prefix. */
  name: 'telemetry',
  /** Package, repository and image name. */
  packageName: packageJson.name,
  /** PostgreSQL schema, owned by the role `<schema>_svc`. */
  schema: 'telemetry',
  /** Default HTTP port (spec §3). */
  port: 3005,
  /** Human name, e.g. "Fleet service" (package.json `displayName`). */
  title: packageJson.displayName,
  description: packageJson.description,
  /** The release version: package.json is its single source. */
  version: packageJson.version,
});

/**
 * The migrations directory of this package, resolved from this module (not
 * from the working directory), so the service and `pnpm migrate` find it
 * wherever they are started (`dist/../migrations`, `src/../migrations`).
 */
export const MIGRATIONS_DIR = fileURLToPath(
  new URL('../migrations', import.meta.url),
);

/**
 * Response headers browsers may read cross-origin besides the kit's
 * defaults (`X-Request-Id`, `Retry-After`, `WWW-Authenticate`, `ETag`,
 * `Location`): the file name of the CSV export.
 */
export const EXPOSED_HEADERS: readonly string[] = ['Content-Disposition'];
