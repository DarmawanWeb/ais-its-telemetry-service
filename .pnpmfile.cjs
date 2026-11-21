'use strict';

/**
 * pnpm hook (read automatically by `pnpm install`): keeps compile-time-only
 * optional peers out of the dependency graph. `@nestjs/swagger` declares
 * `typescript` as an optional peer for its CLI plugin, which this service does
 * not use; without this hook pnpm links the dev dependency `typescript` to it,
 * so `pnpm install --prod` (Docker image) installs TypeScript (about 24 MB).
 */
const COMPILE_TIME_PEERS = {
  '@nestjs/swagger': ['typescript'],
};

/** `record` without the keys in `names`. */
function without(record, names) {
  if (record === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(record).filter(([name]) => !names.includes(name)),
  );
}

function readPackage(manifest) {
  const peers = COMPILE_TIME_PEERS[manifest.name];
  if (peers === undefined) return manifest;
  return {
    ...manifest,
    peerDependencies: without(manifest.peerDependencies, peers),
    peerDependenciesMeta: without(manifest.peerDependenciesMeta, peers),
  };
}

module.exports = { hooks: { readPackage } };
