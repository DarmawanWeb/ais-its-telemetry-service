import {
  getMethod,
  type Method,
  type Reference,
  referencesOfMethod,
} from '@darmawanweb/ais-its-contracts/references';

/** Read access to the methodology catalog (an interface so tests can swap it). */
export interface MethodCatalog {
  method(id: string): Method | undefined;
  references(methodId: string): readonly Reference[];
}

/** The catalog shipped with `@darmawanweb/ais-its-contracts` (`./references`). */
export const CONTRACTS_METHOD_CATALOG: MethodCatalog = {
  method: getMethod,
  references: referencesOfMethod,
};
