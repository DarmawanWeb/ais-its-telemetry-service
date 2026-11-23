'use strict';

/**
 * pnpm hook (read automatically by `pnpm install`): keeps optional peers that
 * only the dev tree satisfies out of the production install (Docker image,
 * `pnpm install --prod`). pnpm links an optional peer to whatever package of
 * the whole tree provides it, so without this hook:
 * - `@nestjs/swagger` (CLI plugin, unused here) gets the dev dependency
 *   `typescript` (about 24 MB);
 * - `@nestjs/terminus` (gRPC health checks, unused here) gets `@grpc/grpc-js`
 *   and `@grpc/proto-loader`, which testcontainers' Docker client `dockerode`
 *   brings into the dev tree (about 11 MB with `protobufjs`).
 * The kit (`@darmawanweb/ais-its-nest` >= 0.3) declares no test packages as
 * peers, so `testcontainers` and `@nestjs/testing` stay devDependencies only.
 */
const DEV_ONLY_PEERS = {
  '@nestjs/swagger': ['typescript'],
  '@nestjs/terminus': ['@grpc/grpc-js', '@grpc/proto-loader'],
};

/** `record` without the keys in `names`. */
function without(record, names) {
  if (record === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(record).filter(([name]) => !names.includes(name)),
  );
}

function readPackage(manifest) {
  const peers = DEV_ONLY_PEERS[manifest.name];
  if (peers === undefined) return manifest;
  return {
    ...manifest,
    peerDependencies: without(manifest.peerDependencies, peers),
    peerDependenciesMeta: without(manifest.peerDependenciesMeta, peers),
  };
}

module.exports = { hooks: { readPackage } };
