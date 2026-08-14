import { hashAdminPassword } from '@edu-api/administration';
import { createPrismaClient } from '@edu-api/database';

async function createSuperAdmin(): Promise<void> {
  const email =
    process.env.ADMIN_INITIAL_SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_INITIAL_SUPER_ADMIN_PASSWORD;
  if (email === undefined || password === undefined) {
    throw new Error(
      'ADMIN_INITIAL_SUPER_ADMIN_EMAIL and ADMIN_INITIAL_SUPER_ADMIN_PASSWORD are required.',
    );
  }

  const database = await createPrismaClient();
  try {
    const existing = await database.adminUser.findFirst({
      where: { role: 'SUPER_ADMIN' },
      select: { id: true },
    });
    if (existing !== null) throw new Error('A Super Admin already exists.');

    const passwordHash = await hashAdminPassword(password);
    const admin = await database.$transaction(async (transaction) => {
      const created = await transaction.adminUser.create({
        data: {
          email,
          passwordHash,
          role: 'SUPER_ADMIN',
          isInitialSuperAdmin: true,
        },
        select: { id: true, publicId: true },
      });
      await transaction.adminSecurityEvent.create({
        data: {
          adminUserId: created.id,
          eventType: 'INITIAL_SUPER_ADMIN_CREATED',
          correlationId: 'initial-super-admin-script',
          metadata: { adminPublicId: created.publicId },
        },
      });
      return created;
    });
    process.stdout.write(
      `Initial Super Admin ${admin.publicId} created. TOTP enrollment is required at first login.\n`,
    );
  } finally {
    await database.$disconnect();
  }
}

void createSuperAdmin();
