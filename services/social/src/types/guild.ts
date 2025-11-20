export interface GuildMember {
  readonly userId: string;
  readonly joinedAt: Date;
}

export interface Guild {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly ownerId: string;
  readonly createdAt: Date;
  readonly members: GuildMember[];
}

export interface GuildStore {
  createGuild(input: {
    readonly name: string;
    readonly description?: string;
    readonly ownerId: string;
  }): Guild;

  getGuildForUser(userId: string): Guild | undefined;

  addMember(guildId: string, userId: string): Guild | undefined;

  getGuildById(guildId: string): Guild | undefined;
}
