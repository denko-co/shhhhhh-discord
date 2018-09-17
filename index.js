const Discord = require('discord.js');
const bot = new Discord.Client({autoReconnect: true});
const credentials = require('./credentials.json');

bot.login(process.env.TOKEN || credentials.discordToken);

bot.on('ready', function (event) {
  console.log('Logged in as %s - %s\n', bot.user.username, bot.user.id);
});

bot.on('message', function (message) {
  if (!message.author.bot) {
    message.channel.send('Hey! o/');
  }
});
