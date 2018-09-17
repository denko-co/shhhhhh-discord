const Discord = require('discord.js');
const Loki = require('lokijs');
const CronJob = require('cron').CronJob;
const winston = require('winston');
const chrono = require('chrono-node');
const bot = new Discord.Client({autoReconnect: true});
const credentials = require('./credentials.json');

let initalised = false;
let db;

winston.configure({
  level: 'info',
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'combined.log' })
  ],
  exceptionHandlers: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'exception.log' })
  ]
});

bot.login(process.env.TOKEN || credentials.discordToken);

init(function (err) {
  if (err) {
    winston.error(err);
    process.exit(1);
  }
  const job = new CronJob('0 */1 * * * *', cleanupMutes);
  job.start();
  winston.info('Ready to rock!');
});

bot.on('ready', function (event) {
  winston.info('Logged in as %s - %s\n', bot.user.username, bot.user.id);
});

bot.on('messageReactionAdd', async function (messageReaction, user) {
  if (messageReaction.emoji.name !== '🔇') return;
  const message = messageReaction.message;
  if (user.bot || message.channel.type !== 'text') return;
  let result = await muteChannel(
    message.guild,
    message.channel,
    user,
    chrono.parseDate('1 hour from now')
  );
  if (result.error) winston.error(result.error);
  dm(`...! (${result.error || result.result})`, {author: user});
});

bot.on('message', async function (message) {
  if (message.author.bot) return;
  const command = message.content.match(/\S+/g) || [];
  const botMention = command.shift();
  if (getUserFromMention(botMention) !== bot.user.id || message.channel.type !== 'text') return;
  const action = command.shift();
  if (!action) return dm('...', message);
  if (action === 'help') {
    return dm('...?! (**<mute | unmute> <channel reference> (time)**, ' +
        'defaults to 1 hour - reacting with 🔇 in a channel mutes it for the default amount)', message);
  }
  if (!['mute', 'unmute'].includes(action)) return dm('...? (mute or unmute?)', message);
  const mute = action === 'mute';
  const channelMention = command.shift();
  const channelToActionId = getChannelFromMention(channelMention);
  const channelToAction = message.guild.channels.get(channelToActionId);
  if (!channelToAction) return dm(`...? (what channel do you want to ${action}?)`, message);
  let timeTimestamp;
  if (mute) {
    const timeSpecified = command.join(' ');
    const now = message.createdAt;
    const nowTimestamp = message.createdTimestamp;
    let timeInterpreted = chrono.parseDate(timeSpecified, now);
    if (!timeInterpreted) timeInterpreted = chrono.parseDate(timeSpecified + ' from now', now);
    if (!timeInterpreted || timeInterpreted.getTime() === nowTimestamp) timeInterpreted = chrono.parseDate('1 hour from now', now);
    winston.info(`Mute time calculated as ${timeInterpreted}`);
    timeTimestamp = timeInterpreted.getTime();
    const minimumMute = chrono.parseDate('1 minutes from now', now);
    if (timeTimestamp < minimumMute) return dm('...! (mute must be at least 1 minute long)', message);
  }
  let result;
  if (mute) {
    result = await muteChannel(message.guild, channelToAction, message.author, timeTimestamp);
  } else {
    result = await unmuteChannel(message.guild, channelToAction, message.author);
  }
  if (result.error) winston.error(result.error);
  dm(`...! (${result.error || result.result})`, message);
});

async function muteChannel (guild, channel, user, endTime) {
  const mutes = db.getCollection('mutes');
  const oldMute = mutes.findOne({
    guildId: guild.id,
    channelId: channel.id,
    userId: user.id
  });
  if (oldMute) {
    oldMute.endTime = endTime;
    return {result: 'channel mute successfully updated'};
  }
  try {
    await channel.overwritePermissions(user, {READ_MESSAGES: false});
    // Overwrite updated, save
    mutes.insert({
      guildId: guild.id,
      channelId: channel.id,
      userId: user.id,
      endTime: endTime
    });
    db.saveDatabase();
    return {result: `channel successfully muted, id to get back is ${channel.id}`};
  } catch (err) {
    winston.error(err);
    return {error: 'an error occured while muting the channel - no mute has been applied'};
  }
}

async function unmuteChannel (guild, channel, user) {
  const mutes = db.getCollection('mutes');
  const oldMute = mutes.findOne({
    guildId: guild.id,
    channelId: channel.id,
    userId: user.id
  });
  if (!oldMute) return {error: 'no current mute recorded to disable'};
  const muteOverwrite = channel.permissionOverwrites.get(user.id);
  let result;
  if (!muteOverwrite) {
    result = {error: 'no current mute overwrite found to disable'};
  } else {
    try {
      if (muteOverwrite.allowed.bitfield === 0 && muteOverwrite.denied.bitfield === 1024) {
        // Remove the mute overwrite
        await muteOverwrite.delete();
        result = {result: 'mute successfully removed'};
      } else {
        // Unset the read permission
        await channel.overwritePermissions(user, {READ_MESSAGES: null});
        result = {result: 'mute successfully removed, user permission remains'};
      }
    } catch (err) {
      winston.error(err);
      return {error: 'mute could not be removed'};
    }
  }
  mutes.remove(oldMute);
  db.saveDatabase();
  return result;
}

function dm (contents, message) {
  message.author.send(contents);
  if (message.id) message.delete(); // ;)
}

function cleanupMutes () {
  const mutes = db.getCollection('mutes');
  const now = new Date();
  const expiredMutes = mutes.find({'endTime': {'$lte': now.getTime()}});
  expiredMutes.forEach(async muteObj => {
    winston.info('Expiring mute with info:');
    winston.info(muteObj);
    const result = await unmuteChannel(
      bot.guilds.get(muteObj.guildId),
      bot.channels.get(muteObj.channelId),
      bot.users.get(muteObj.userId)
    );
    if (result.error) winston.error(result.error);
  });
}

function getUserFromMention (mention) {
  return mention.replace(/[<@!>]/g, '');
}

function getChannelFromMention (mention) {
  return mention.replace(/[<#>]/g, '');
}

function init (callback) {
  if (initalised) return;
  initalised = true;
  db = new Loki('./muteDetails.json');

  db.loadDatabase({}, function (err) {
    if (err) {
      callback(err);
    } else {
      if (!db.getCollection('mutes')) db.addCollection('mutes');
      db.saveDatabase(function (err) {
        if (err) {
          callback(err);
        } else {
          winston.info('Init worked, calling back.');
          callback();
        }
      });
    }
  });
};
