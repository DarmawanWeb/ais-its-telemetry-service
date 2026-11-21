import {
  MethodSchema,
  ReferenceSchema,
} from '@darmawanweb/ais-its-contracts/references';
import { describe, expect, it } from 'vitest';

import type { MethodCatalog } from './method-catalog.js';
import { MethodologyDto } from './methodology.dto.js';
import { MethodologyService } from './methodology.service.js';

const method = MethodSchema.parse({
  id: 'cii.attained',
  domain: 'emission',
  name: { id: 'CII tercapai', en: 'Attained CII' },
  summary: { id: 'Ringkasan', en: 'Summary' },
  referenceIds: ['imo-mepc-352-78'],
  status: 'implemented',
});

const reference = ReferenceSchema.parse({
  id: 'imo-mepc-352-78',
  type: 'regulation',
  title: 'Resolution MEPC.352(78)',
  issuerOrAuthors: 'IMO MEPC',
  url: 'https://www.imo.org/',
  verification: 'verified',
});

/** A catalog that knows exactly one method. */
const catalog: MethodCatalog = {
  method: (id) => (id === method.id ? method : undefined),
  references: (id) => (id === method.id ? [reference] : []),
};

/** What `GET …/methodology` returns for the service's ids. */
function describeIds(ids: string[]): MethodologyDto {
  return new MethodologyDto(
    new MethodologyService('demo', ids, catalog).describe(),
  );
}

describe('MethodologyService', () => {
  it('resolves catalogued methods with their references', () => {
    expect(describeIds(['cii.attained'])).toEqual({
      service: 'demo',
      methods: [
        {
          id: 'cii.attained',
          catalogued: true,
          domain: 'emission',
          name: { id: 'CII tercapai', en: 'Attained CII' },
          status: 'implemented',
          needsCitation: false,
          references: [
            {
              id: 'imo-mepc-352-78',
              title: 'Resolution MEPC.352(78)',
              url: 'https://www.imo.org/',
            },
          ],
        },
      ],
    });
  });

  it('lists ids missing from the catalog as not catalogued', () => {
    expect(describeIds(['x.unknown']).methods).toEqual([
      expect.objectContaining({
        id: 'x.unknown',
        catalogued: false,
        name: null,
        references: [],
      }),
    ]);
  });

  it('keeps the declaration order and drops duplicates', () => {
    const { methods } = describeIds(['b.second', 'cii.attained', 'b.second']);

    expect(methods.map((entry) => entry.id)).toEqual([
      'b.second',
      'cii.attained',
    ]);
  });
});
