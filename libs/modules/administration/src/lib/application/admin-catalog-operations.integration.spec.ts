import { randomUUID } from 'node:crypto';

import { createPrismaClient, type DatabaseClient } from '@edu-api/database';
import {
  CatalogNotFoundError,
  CatalogValidationError,
  PrismaCatalogAdminService,
} from '@edu-api/catalog';

import { PrismaAdminCatalogOperationsService } from './admin-catalog-operations';
import type { AuthenticatedAdmin } from './administration-types';

const databaseUrl = process.env.ADMIN_CATALOG_TEST_DATABASE_URL;
const describeWithDatabase =
  databaseUrl === undefined ? describe.skip : describe;

describeWithDatabase('PrismaAdminCatalogOperationsService (PostgreSQL)', () => {
  let actor: AuthenticatedAdmin;
  let codeSuffix: string;
  let database: DatabaseClient;
  let operations: PrismaAdminCatalogOperationsService;

  beforeAll(async () => {
    database = await createPrismaClient({ DATABASE_URL: databaseUrl });
    operations = new PrismaAdminCatalogOperationsService(
      database,
      new PrismaCatalogAdminService(),
    );
  });

  beforeEach(async () => {
    codeSuffix = randomUUID().replace(/-/g, '').toUpperCase();
    const administrator = await database.adminUser.create({
      data: {
        email: `catalog-${codeSuffix.toLowerCase()}@integration.test`,
        passwordHash: 'integration-test-password-hash',
        role: 'OPERATIONS_ADMIN',
      },
      select: { id: true, publicId: true },
    });
    actor = {
      id: administrator.id,
      publicId: administrator.publicId,
      role: 'OPERATIONS_ADMIN',
      sessionId: BigInt(0),
    };
  });

  afterEach(async () => {
    const productIds = (
      await database.product.findMany({
        where: { code: { contains: codeSuffix } },
        select: { id: true },
      })
    ).map((product) => product.id);
    if (productIds.length !== 0) {
      await database.outboxEvent.deleteMany({
        where: {
          aggregateType: 'CatalogProduct',
          aggregateId: { in: productIds },
        },
      });
      await database.product.deleteMany({ where: { id: { in: productIds } } });
    }
    await database.catalogGroup.updateMany({
      where: { code: { contains: codeSuffix } },
      data: { parentId: null },
    });
    await database.catalogGroup.deleteMany({
      where: { code: { contains: codeSuffix } },
    });
    await database.adminSecurityEvent.deleteMany({
      where: { adminUserId: actor.id },
    });
    await database.adminUser.delete({ where: { id: actor.id } });
  });

  afterAll(async () => {
    await database.$disconnect();
  });

  it('commits catalog state, its durable event, and its audit record atomically', async () => {
    const root = await operations.createGroup(
      actor,
      {
        code: `EDUCATION_${codeSuffix}`,
        name: 'Education',
        sortOrder: 0,
      },
      { correlationId: 'catalog-root' },
    );
    const group = await operations.createGroup(
      actor,
      {
        code: `WAEC_${codeSuffix}`,
        name: 'WAEC',
        parentPublicId: root.publicId,
        sortOrder: 0,
      },
      { correlationId: 'catalog-group' },
    );
    const product = await operations.createProduct(
      actor,
      {
        catalogGroupPublicId: group.publicId,
        code: `WASSCE_${codeSuffix}`,
        currency: 'GHS',
        lowStockThreshold: 25,
        name: 'WASSCE Result Checker',
        resultCheckerUrl: 'https://ghana.waecdirect.org/',
        sellingPriceMinor: '2500',
      },
      { correlationId: 'catalog-product' },
    );

    const storedProduct = await database.product.findUniqueOrThrow({
      where: { publicId: product.publicId },
      select: { id: true, sellingPriceMinor: true },
    });
    await expect(
      database.outboxEvent.findFirst({
        where: {
          aggregateId: storedProduct.id,
          aggregateType: 'CatalogProduct',
          eventType: 'CatalogProductCreated',
        },
      }),
    ).resolves.toMatchObject({
      payload: expect.objectContaining({ productPublicId: product.publicId }),
    });
    await expect(
      database.adminSecurityEvent.findFirst({
        where: {
          adminUserId: actor.id,
          correlationId: 'catalog-product',
          eventType: 'CATALOG_PRODUCT_CREATED',
        },
      }),
    ).resolves.toMatchObject({
      metadata: expect.objectContaining({ productPublicId: product.publicId }),
    });

    const price = await operations.changeProductPrice(
      actor,
      product.publicId,
      { currency: 'GHS', sellingPriceMinor: '3000' },
      { correlationId: 'catalog-price' },
    );
    expect(price).toMatchObject({
      changed: true,
      product: { sellingPriceMinor: '3000' },
    });
    const deactivated = await operations.setProductActivation(
      actor,
      product.publicId,
      false,
      { correlationId: 'catalog-deactivate' },
    );
    expect(deactivated).toMatchObject({
      changed: true,
      product: { isActive: false },
    });
    const repeated = await operations.setProductActivation(
      actor,
      product.publicId,
      false,
      { correlationId: 'catalog-deactivate-repeat' },
    );
    expect(repeated.changed).toBe(false);
    await expect(
      database.outboxEvent.count({
        where: {
          aggregateId: storedProduct.id,
          aggregateType: 'CatalogProduct',
        },
      }),
    ).resolves.toBe(3);
  });

  it('rejects a group move that would create an ancestor cycle', async () => {
    const root = await operations.createGroup(
      actor,
      { code: `ROOT_${codeSuffix}`, name: 'Root', sortOrder: 0 },
      { correlationId: 'catalog-cycle-root' },
    );
    const child = await operations.createGroup(
      actor,
      {
        code: `CHILD_${codeSuffix}`,
        name: 'Child',
        parentPublicId: root.publicId,
        sortOrder: 0,
      },
      { correlationId: 'catalog-cycle-child' },
    );

    await expect(
      operations.updateGroup(
        actor,
        root.publicId,
        { parentPublicId: child.publicId },
        { correlationId: 'catalog-cycle-invalid' },
      ),
    ).rejects.toBeInstanceOf(CatalogValidationError);
  });

  it('preserves an acyclic hierarchy when opposing group moves race', async () => {
    const root = await operations.createGroup(
      actor,
      { code: `RACE_ROOT_${codeSuffix}`, name: 'Root', sortOrder: 0 },
      { correlationId: 'catalog-race-root' },
    );
    const first = await operations.createGroup(
      actor,
      {
        code: `RACE_FIRST_${codeSuffix}`,
        name: 'First',
        parentPublicId: root.publicId,
        sortOrder: 0,
      },
      { correlationId: 'catalog-race-first' },
    );
    const second = await operations.createGroup(
      actor,
      {
        code: `RACE_SECOND_${codeSuffix}`,
        name: 'Second',
        parentPublicId: root.publicId,
        sortOrder: 1,
      },
      { correlationId: 'catalog-race-second' },
    );

    const results = await Promise.allSettled([
      operations.updateGroup(
        actor,
        first.publicId,
        { parentPublicId: second.publicId },
        { correlationId: 'catalog-race-first-move' },
      ),
      operations.updateGroup(
        actor,
        second.publicId,
        { parentPublicId: first.publicId },
        { correlationId: 'catalog-race-second-move' },
      ),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);

    const groups = await database.catalogGroup.findMany({
      where: { publicId: { in: [first.publicId, second.publicId] } },
      select: { publicId: true, parent: { select: { publicId: true } } },
    });
    const firstStored = groups.find(
      (group) => group.publicId === first.publicId,
    );
    const secondStored = groups.find(
      (group) => group.publicId === second.publicId,
    );
    expect(
      firstStored?.parent?.publicId === second.publicId &&
        secondStored?.parent?.publicId === first.publicId,
    ).toBe(false);
  });

  it('rolls back the audit record when the catalog command is rejected', async () => {
    await expect(
      operations.createProduct(
        actor,
        {
          catalogGroupPublicId: '1f39d1f1-0e1b-4d7a-9b3a-fc3adca653a1',
          code: `MISSING_GROUP_${codeSuffix}`,
          currency: 'GHS',
          lowStockThreshold: 0,
          name: 'Missing group product',
          sellingPriceMinor: '100',
        },
        { correlationId: 'catalog-missing-group' },
      ),
    ).rejects.toBeInstanceOf(CatalogNotFoundError);
    await expect(
      database.adminSecurityEvent.count({
        where: {
          adminUserId: actor.id,
          correlationId: 'catalog-missing-group',
        },
      }),
    ).resolves.toBe(0);
  });
});
