import "dotenv/config";

import { db } from "./db/client";
import { hashPassword } from "./utils/password";

const seedUsers = [
  {
    name: "Admin",
    email: "admin@example.com",
    password: "password",
    role: "admin",
    gameSlug: "admin-game",
  },
  {
    name: "User",
    email: "user@example.com",
    password: "password",
    role: "user",
    gameSlug: "user-game",
  },
];

async function seed() {
  for (const user of seedUsers) {
    let existing = await db.user.findFirst({ where: { email: user.email } });

    if (!existing) {
      existing = await db.user.create({
        data: {
          name: user.name,
          email: user.email,
          passwordHash: await hashPassword(user.password),
          role: user.role,
        },
      });
    } else if (!existing.name) {
      await db.user.update({ where: { id: existing.id }, data: { name: user.name } });
    }

    // login requires a default game (auth.router.ts), so ensure each seed user owns one
    let game = await db.game.findFirst({ where: { slug: user.gameSlug } });
    if (!game) {
      game = await db.game.create({
        data: { slug: user.gameSlug, name: `${user.name}的游戏` },
      });
    }

    const member = await db.gameMember.findFirst({
      where: { gameId: game.id, userId: existing.id },
    });
    if (!member) {
      await db.gameMember.create({
        data: { gameId: game.id, userId: existing.id, role: "owner" },
      });
    }
  }

  console.log("Seed completed");
  process.exit(0);
}

seed().catch((error) => {
  console.error(error);
  process.exit(1);
});
