import type {
  Method,
  Reference,
} from '@darmawanweb/ais-its-contracts/references';

import type { MethodCatalog } from './method-catalog.js';

/** A method id of the service with its catalog entry, when the catalog has one. */
export interface ImplementedMethod {
  readonly id: string;
  /** `undefined` when the shipped catalog does not describe the id (yet). */
  readonly method: Method | undefined;
  readonly references: readonly Reference[];
}

/** The methods a service implements. */
export interface MethodologyDescription {
  readonly service: string;
  readonly methods: readonly ImplementedMethod[];
}

/**
 * Describes the methods this service implements (spec §17) from the
 * methodology catalog; ids missing from the shipped catalog are listed
 * without details instead of failing.
 */
export class MethodologyService {
  constructor(
    private readonly serviceName: string,
    private readonly methodIds: readonly string[],
    private readonly catalog: MethodCatalog,
  ) {}

  /** The service's methods in declaration order, without duplicates. */
  describe(): MethodologyDescription {
    return {
      service: this.serviceName,
      methods: [...new Set(this.methodIds)].map((id) => ({
        id,
        method: this.catalog.method(id),
        references: this.catalog.references(id),
      })),
    };
  }
}
