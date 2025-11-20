import crypto from 'node:crypto';

import type { Guild, GuildStore } from '../types/guild.js';

function generateGuildId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `guild-${crypto.randomBytes(8).toString('hex')}`;
}

class InMemoryGuildStore implements GuildStore {
  private readonly guilds = new Map<string, Guild>();

  private readonly membership = new Map<string, string>();

  createGuild(input: {
    readonly name: string;
    readonly description?: string;
    readonly ownerId: string;
  }): Guild {
    const existingGuildId = this.membership.get(input.ownerId);
    if (existingGuildId) {
      const existingGuild = this.guilds.get(existingGuildId);
      if (existingGuild) {
        return existingGuild;
      }
    }

    const now = new Date();
    const guild: Guild = {
      id: generateGuildId(),
      name: input.name,
      description: input.description,
      ownerId: input.ownerId,
      createdAt: now,
      members: [
        {
          userId: input.ownerId,
          joinedAt: now,
        },
      ],
    };

    this.guilds.set(guild.id, guild);
    this.membership.set(input.ownerId, guild.id);

    return guild;
  }

  getGuildForUser(userId: string): Guild | undefined {
    const guildId = this.membership.get(userId);
    if (!guildId) {
      return undefined;
    }
    return this.guilds.get(guildId);
  }

  addMember(guildId: string, userId: string): Guild | undefined {
    const guild = this.guilds.get(guildId);
    if (!guild) {
      return undefined;
    }
    const existingGuild = this.membership.get(userId);
    if (existingGuild) {
      return this.guilds.get(existingGuild);
    }

    const now = new Date();
    guild.members.push({
      userId,
      joinedAt: now,
    });
    this.membership.set(userId, guildId);
    return guild;
  }

  getGuildById(guildId: string): Guild | undefined {
    return this.guilds.get(guildId);
  }
}

export function createInMemoryGuildStore(): GuildStore {
  return new InMemoryGuildStore();
}
