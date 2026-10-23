/**
 * The bot roster Pyrodeck writes when an operator asks for a fresh one: the
 * sample that ships with Matcen (`matcen-docs/samples/bots.cfg`), with its
 * comments, so the file explains itself when opened in the raw editor.
 *
 * Four bots join at start, the population manager keeps 12 players in the
 * game, one seat stays free for humans. Keep this in step with the sample when
 * the fork changes it.
 */
export const SAMPLE_BOT_ROSTER =
  "; Matcen sample bot roster, read through BotConfig=bots.cfg in dedicated.cfg.\n" +
  "; One Key=Value per line. Comments go on their own line: a ; after a value\n" +
  "; becomes part of the value.\n" +
  ";\n" +
  "; Bots that join when the server starts.\n" +
  "BotCount=4\n" +
  "; Keep 12 players in the game: bots join as humans leave and leave as humans\n" +
  "; join. 0 (the default) turns this off. With MaxPlayers=14 in dedicated.cfg\n" +
  "; (the server's seat, 12 players, 1 free seat) the game stays full and every\n" +
  "; human replaces a bot; a larger MaxPlayers lets humans outgrow the bots.\n" +
  "; Use an even number in team games, or one team is always a player bigger.\n" +
  "BotTargetPlayers=12\n" +
  "; Seats always left free for humans (default 1, minimum 1).\n" +
  "BotReservedSlots=1\n" +
  "; Difficulty for every bot: trainee, rookie, hotshot, ace or insane.\n" +
  "BotDifficulty=hotshot\n" +
  "; The roster, up to 16 entries. Names are cut to 14 characters and get [BOT]\n" +
  "; added. Ships: pyro, phoenix, magnum, blackpyro (Black Pyro needs Mercenary).\n" +
  "; BotDifficulty<n> overrides the difficulty for one bot. BotTeam<n> is 1-4 in\n" +
  "; team games; leave it out and the bot joins the smallest team.\n" +
  "; Bots the target adds beyond the roster get built-in names.\n" +
  "BotName1=Reaper\n" +
  "BotShip1=pyro\n" +
  "BotDifficulty1=ace\n" +
  "BotTeam1=1\n" +
  "BotName2=Phantom\n" +
  "BotShip2=phoenix\n" +
  "BotTeam2=2\n" +
  "BotName3=Viper\n" +
  "BotName4=Shadow\n";
