import {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, InteractionType,
  Events, ActivityType,
} from "discord.js";
import mineflayer from "mineflayer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "discord-slots.json");

// ─── Persistence ───────────────────────────────────────────────────────────────
function loadData() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8")); } catch {}
  return {};
}
function saveData(d) { try { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); } catch {} }

let db = loadData();
// db[userId] = { host, port, version, username, password, registered, discordChannel }

function getUser(userId) { return db[userId] ?? null; }
function setUser(userId, data) { db[userId] = data; saveData(db); }
function deleteUser(userId) { delete db[userId]; saveData(db); }

// ─── Bot Instances ─────────────────────────────────────────────────────────────
const bots = new Map(); // userId -> { bot, reconnectTimer, afkTimer, shouldReconnect, isReconnecting, destroyed }

function freshState(userId) {
  return { userId, bot: null, reconnectTimer: null, afkTimer: null, shouldReconnect: false, isReconnecting: false, destroyed: true };
}

function getState(userId) {
  if (!bots.has(userId)) bots.set(userId, freshState(userId));
  return bots.get(userId);
}

function isOnline(userId) { return !!(getState(userId).bot?.entity); }
function isReconnecting(userId) { return getState(userId).isReconnecting; }

function stopAfk(state) { if (state.afkTimer) { clearInterval(state.afkTimer); state.afkTimer = null; } }
function startAfk(state) {
  stopAfk(state);
  state.afkTimer = setInterval(() => {
    if (!state.bot?.entity) return;
    try {
      state.bot.look(state.bot.entity.yaw + (Math.random() - 0.5) * 0.5, state.bot.entity.pitch + (Math.random() - 0.5) * 0.2, false);
      if (Math.random() < 0.25) { state.bot.setControlState("forward", true); setTimeout(() => state.bot?.setControlState("forward", false), 200); }
    } catch {}
  }, 9000 + Math.random() * 3000);
}

function cancelReconnect(state) { if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; } }

function destroyBot(state) {
  if (state.destroyed) return;
  state.destroyed = true;
  stopAfk(state);
  const b = state.bot; state.bot = null;
  try { b?.quit?.(); } catch {}
  try { b?.end?.(); } catch {}
}

function scheduleReconnect(state, delayMs) {
  cancelReconnect(state);
  if (!state.shouldReconnect) return;
  state.isReconnecting = true;
  const delay = delayMs ?? (7000 + Math.random() * 5000);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    if (state.shouldReconnect) { const d = getUser(state.userId); if (d) launchBot(state.userId, d); }
  }, delay);
}

// ─── Log to Discord DM ─────────────────────────────────────────────────────────
async function logToDiscord(client, userId, msg) {
  try {
    const user = await client.users.fetch(userId).catch(() => null);
    if (user) await user.send({ content: `\`[MC Log]\` ${msg}` }).catch(() => {});
  } catch {}
}

// ─── Launch Mineflayer Bot ─────────────────────────────────────────────────────
function launchBot(userId, cfg, client) {
  const state = getState(userId);
  state.destroyed = false;

  const b = mineflayer.createBot({
    host: cfg.host, port: Number(cfg.port), username: cfg.username,
    version: cfg.version || "1.21", auth: "offline", hideErrors: false,
  });
  state.bot = b;

  b.once("spawn", () => {
    if (b !== state.bot) return;
    state.isReconnecting = false;
    if (client) logToDiscord(client, userId, `✅ Joined **${cfg.host}:${cfg.port}** as **${cfg.username}**`);
    startAfk(state);
    if (cfg.password) setTimeout(() => { if (b !== state.bot) return; try { b.chat(`/login ${cfg.password}`); } catch {} }, 1500);
  });

  b.on("chat", (username, message) => {
    if (b !== state.bot || username === b.username) return;
    if (client) logToDiscord(client, userId, `💬 **${username}**: ${message}`);
  });

  b.on("message", (jsonMsg) => {
    if (b !== state.bot) return;
    const raw = jsonMsg.toString();
    const lower = raw.toLowerCase();
    if (cfg.password) {
      if (lower.includes("/register") || lower.includes("please register")) { setTimeout(() => { if (b !== state.bot) return; try { b.chat(`/register ${cfg.password} ${cfg.password}`); } catch {} }, 800); return; }
      if (lower.includes("/login") || lower.includes("please login")) { setTimeout(() => { if (b !== state.bot) return; try { b.chat(`/login ${cfg.password}`); } catch {} }, 800); return; }
    }
  });

  b.on("error", (err) => { if (b !== state.bot) return; if (client) logToDiscord(client, userId, `⚠️ Error: ${err.message}`); });

  b.on("kicked", (reason) => {
    if (b !== state.bot) return;
    let msg = reason; try { msg = JSON.parse(reason)?.text ?? reason; } catch {}
    if (client) logToDiscord(client, userId, `❌ Kicked: ${msg}`);
    destroyBot(state);
    scheduleReconnect(state, msg.toLowerCase().includes("already") ? 30000 : undefined);
  });

  b.on("end", (reason) => {
    if (b !== state.bot) return;
    if (client) logToDiscord(client, userId, `🔄 Disconnected (${reason ?? "unknown"}). Reconnecting...`);
    destroyBot(state);
    scheduleReconnect(state, undefined);
  });
}

// ─── Action Helpers ────────────────────────────────────────────────────────────
function startUserBot(userId, client) {
  const d = getUser(userId);
  if (!d?.registered || !d?.host) return false;
  const state = getState(userId);
  state.shouldReconnect = false; cancelReconnect(state); destroyBot(state);
  state.shouldReconnect = true; state.isReconnecting = false; state.destroyed = false;
  launchBot(userId, d, client);
  return true;
}

function stopUserBot(userId) {
  const state = getState(userId);
  state.shouldReconnect = false; state.isReconnecting = false;
  cancelReconnect(state); destroyBot(state);
}

function restartUserBot(userId, client) {
  stopUserBot(userId);
  setTimeout(() => startUserBot(userId, client), 2000);
}

// ─── Embed Builders ────────────────────────────────────────────────────────────
function buildMainEmbed() {
  const totalUsers = Object.keys(db).length;
  const online = [...bots.values()].filter(s => s.bot?.entity).length;
  const reconnecting = [...bots.values()].filter(s => s.isReconnecting).length;
  const slots = parseInt(process.env.MAX_SLOTS || "100");

  return new EmbedBuilder()
    .setTitle("🎮 AFK Bot Control Panel")
    .setDescription("Manage your personal AFK bot using the buttons below.\n\n• Secure backend system\n• Auto reconnect support\n• One bot per user\n• Role Required to Use Panel.")
    .addFields(
      { name: "System Status 📊", value: "🟢 Online", inline: true },
      { name: "Active Bots 🤖", value: String(online + reconnecting), inline: true },
      { name: "Available Slots 🔌", value: String(Math.max(0, slots - totalUsers)), inline: true },
    )
    .setColor(0x5865F2)
    .setFooter({ text: "MC AFK Bot Panel • Made by King Khizar" })
    .setTimestamp();
}

function buildUserEmbed(userId) {
  const d = getUser(userId);
  const online = isOnline(userId);
  const recon = isReconnecting(userId);
  const state = getState(userId);
  const players = online ? Object.values(state.bot?.players ?? {}).map(p => p.username) : [];

  const statusStr = online ? "🟢 Online" : recon ? "🟡 Reconnecting..." : "🔴 Offline";

  const embed = new EmbedBuilder()
    .setTitle(`⛏ Your Bot — Slot`)
    .setColor(online ? 0x3ba55c : recon ? 0xfaa81a : 0xed4245)
    .setFooter({ text: "MC AFK Bot Panel • Made by King Khizar" })
    .setTimestamp();

  if (d?.registered) {
    embed.addFields(
      { name: "Status", value: statusStr, inline: true },
      { name: "Players Online", value: online ? String(players.length) : "—", inline: true },
      { name: "Server", value: `${d.host}:${d.port || 25565}`, inline: true },
      { name: "Username", value: d.username, inline: true },
      { name: "Version", value: d.version || "1.21", inline: true },
      { name: "Auth", value: d.password ? "AuthMe ✅" : "None", inline: true },
    );
    if (online && players.length > 0) embed.addFields({ name: "Online Players", value: players.slice(0, 10).join(", "), inline: false });
  } else {
    embed.setDescription("You haven't registered yet.\nClick **Register** to set up your Minecraft bot.");
  }
  return embed;
}

function botControlRow(userId) {
  const d = getUser(userId);
  const online = isOnline(userId);
  const registered = d?.registered ?? false;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`register_${userId}`).setLabel("Register").setStyle(ButtonStyle.Primary).setEmoji("📝"),
    new ButtonBuilder().setCustomId(`start_${userId}`).setLabel("Start Bot").setStyle(ButtonStyle.Success).setEmoji("▶").setDisabled(!registered),
    new ButtonBuilder().setCustomId(`stop_${userId}`).setLabel("Stop Bot").setStyle(ButtonStyle.Danger).setEmoji("⏹").setDisabled(!online),
  );
}

function botControlRow2(userId) {
  const registered = getUser(userId)?.registered ?? false;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`restart_${userId}`).setLabel("Restart Bot").setStyle(ButtonStyle.Secondary).setEmoji("🔄").setDisabled(!registered),
    new ButtonBuilder().setCustomId(`status_${userId}`).setLabel("Status").setStyle(ButtonStyle.Secondary).setEmoji("📊"),
    new ButtonBuilder().setCustomId(`delete_${userId}`).setLabel("Delete").setStyle(ButtonStyle.Danger).setEmoji("🗑"),
  );
}

function mainPanelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("open_panel").setLabel("PANEL").setStyle(ButtonStyle.Primary).setEmoji("🎮"),
  );
}

// ─── Start Discord Bot ─────────────────────────────────────────────────────────
export async function startDiscordBot() {
  const token = process.env.DISCORD_BOT_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!token || !clientId) {
    console.log("[Discord] Missing DISCORD_BOT_TOKEN or DISCORD_CLIENT_ID — Discord bot disabled.");
    return;
  }

  // Register slash commands
  const rest = new REST().setToken(token);
  const commands = [
    new SlashCommandBuilder().setName("panel").setDescription("Open the AFK Bot Control Panel").toJSON(),
    new SlashCommandBuilder().setName("status").setDescription("Check your bot status").toJSON(),
    new SlashCommandBuilder().setName("start").setDescription("Start your AFK bot").toJSON(),
    new SlashCommandBuilder().setName("stop").setDescription("Stop your AFK bot").toJSON(),
    new SlashCommandBuilder().setName("restart").setDescription("Restart your AFK bot").toJSON(),
    new SlashCommandBuilder().setName("admin_list").setDescription("[Admin] List all active bots").toJSON(),
  ];

  try {
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
      console.log("[Discord] Guild slash commands registered.");
    } else {
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
      console.log("[Discord] Global slash commands registered.");
    }
  } catch (e) { console.error("[Discord] Command registration failed:", e.message); }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  });

  client.once(Events.ClientReady, () => {
    console.log(`[Discord] Logged in as ${client.user.tag}`);
    client.user.setActivity("Minecraft AFK Bots", { type: ActivityType.Watching });
    // Auto-start saved bots
    for (const [uid, d] of Object.entries(db)) {
      if (d?.registered && d?.host) {
        console.log(`[Discord] Auto-starting bot for user ${uid}`);
        setTimeout(() => startUserBot(uid, client), 4000 + Math.random() * 3000);
      }
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    // ── Slash Commands ──
    if (interaction.isChatInputCommand()) {
      const userId = interaction.user.id;
      const cmd = interaction.commandName;

      if (cmd === "panel") {
        await interaction.reply({
          embeds: [buildMainEmbed()],
          components: [mainPanelRow()],
        });
        return;
      }

      if (cmd === "status") {
        await interaction.reply({ embeds: [buildUserEmbed(userId)], ephemeral: true });
        return;
      }

      if (cmd === "start") {
        const d = getUser(userId);
        if (!d?.registered) { await interaction.reply({ content: "❌ You haven't registered yet! Use `/panel` first.", ephemeral: true }); return; }
        startUserBot(userId, client);
        await interaction.reply({ content: "🚀 Bot is starting...", ephemeral: true });
        return;
      }

      if (cmd === "stop") {
        if (!isOnline(userId)) { await interaction.reply({ content: "❌ Your bot is not online.", ephemeral: true }); return; }
        stopUserBot(userId);
        await interaction.reply({ content: "⏹ Bot stopped.", ephemeral: true });
        return;
      }

      if (cmd === "restart") {
        const d = getUser(userId);
        if (!d?.registered) { await interaction.reply({ content: "❌ You haven't registered yet!", ephemeral: true }); return; }
        restartUserBot(userId, client);
        await interaction.reply({ content: "🔄 Bot restarting...", ephemeral: true });
        return;
      }

      if (cmd === "admin_list") {
        const adminId = process.env.DISCORD_ADMIN_ID;
        if (adminId && interaction.user.id !== adminId) { await interaction.reply({ content: "❌ Admin only.", ephemeral: true }); return; }
        const lines = [];
        for (const [uid, d] of Object.entries(db)) {
          const online = isOnline(uid);
          const recon = isReconnecting(uid);
          lines.push(`<@${uid}> — **${d.username || "?"}** @ ${d.host || "?"} — ${online ? "🟢" : recon ? "🟡" : "🔴"}`);
        }
        const embed = new EmbedBuilder().setTitle("📋 All Registered Users").setDescription(lines.length ? lines.join("\n") : "None registered").setColor(0x5865F2);
        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }
    }

    // ── Buttons ──
    if (interaction.isButton()) {
      const customId = interaction.customId;

      // Main panel button
      if (customId === "open_panel") {
        const userId = interaction.user.id;
        await interaction.reply({
          embeds: [buildUserEmbed(userId)],
          components: [botControlRow(userId), botControlRow2(userId)],
          ephemeral: true,
        });
        return;
      }

      // Parse userId from button custom ID
      const [action, ...rest2] = customId.split("_");
      const targetUserId = rest2.join("_");

      // Security: only the owner can use their buttons
      if (targetUserId !== interaction.user.id) {
        await interaction.reply({ content: "❌ This panel belongs to someone else!", ephemeral: true });
        return;
      }
      const userId = targetUserId;

      if (action === "register") {
        const d = getUser(userId);
        const modal = new ModalBuilder().setCustomId(`modal_register_${userId}`).setTitle(`Register Your MC Bot`);
        const hostInput = new TextInputBuilder().setCustomId("host").setLabel("Server IP / Host").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("play.example.com").setValue(d?.host ?? "");
        const portInput = new TextInputBuilder().setCustomId("port").setLabel("Server Port").setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder("25565").setValue(String(d?.port ?? 25565));
        const verInput = new TextInputBuilder().setCustomId("version").setLabel("Minecraft Version").setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder("1.21").setValue(d?.version ?? "1.21");
        const userInput = new TextInputBuilder().setCustomId("username").setLabel("Bot Username").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("AFKBot").setValue(d?.username ?? "");
        const passInput = new TextInputBuilder().setCustomId("password").setLabel("AuthMe Password (leave blank if not needed)").setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder("Leave blank if server doesn't use AuthMe");
        modal.addComponents(
          new ActionRowBuilder().addComponents(hostInput),
          new ActionRowBuilder().addComponents(portInput),
          new ActionRowBuilder().addComponents(verInput),
          new ActionRowBuilder().addComponents(userInput),
          new ActionRowBuilder().addComponents(passInput),
        );
        await interaction.showModal(modal);
        return;
      }

      if (action === "start") {
        const d = getUser(userId);
        if (!d?.registered) { await interaction.reply({ content: "❌ Register first!", ephemeral: true }); return; }
        startUserBot(userId, client);
        await interaction.update({ embeds: [buildUserEmbed(userId)], components: [botControlRow(userId), botControlRow2(userId)] });
        await interaction.followUp({ content: "🚀 Bot is starting! You'll get a DM when it joins.", ephemeral: true });
        return;
      }

      if (action === "stop") {
        stopUserBot(userId);
        await interaction.update({ embeds: [buildUserEmbed(userId)], components: [botControlRow(userId), botControlRow2(userId)] });
        await interaction.followUp({ content: "⏹ Bot stopped.", ephemeral: true });
        return;
      }

      if (action === "restart") {
        restartUserBot(userId, client);
        await interaction.update({ embeds: [buildUserEmbed(userId)], components: [botControlRow(userId), botControlRow2(userId)] });
        await interaction.followUp({ content: "🔄 Restarting...", ephemeral: true });
        return;
      }

      if (action === "status") {
        try { await interaction.update({ embeds: [buildUserEmbed(userId)], components: [botControlRow(userId), botControlRow2(userId)] }); } catch {}
        return;
      }

      if (action === "delete") {
        stopUserBot(userId);
        deleteUser(userId);
        const embed = new EmbedBuilder().setTitle("🗑 Bot Deleted").setDescription("Your bot slot has been deleted. Use the panel to register again.").setColor(0xed4245);
        await interaction.update({ embeds: [embed], components: [] });
        return;
      }
    }

    // ── Modals ──
    if (interaction.type === InteractionType.ModalSubmit) {
      if (interaction.customId.startsWith("modal_register_")) {
        const userId = interaction.customId.replace("modal_register_", "");
        if (userId !== interaction.user.id) { await interaction.reply({ content: "❌ Not your panel!", ephemeral: true }); return; }

        const host = interaction.fields.getTextInputValue("host").trim();
        const port = parseInt(interaction.fields.getTextInputValue("port").trim() || "25565");
        const version = interaction.fields.getTextInputValue("version").trim() || "1.21";
        const username = interaction.fields.getTextInputValue("username").trim();
        const password = interaction.fields.getTextInputValue("password").trim() || null;

        if (!host || !username) { await interaction.reply({ content: "❌ Host and Username are required!", ephemeral: true }); return; }

        setUser(userId, { host, port, version, username, password, registered: true, discordTag: interaction.user.tag });

        await interaction.reply({
          content: `✅ **Registered!** Your bot is set up.\n\n🖥 Server: \`${host}:${port}\`\n👤 Username: \`${username}\`\n📌 Version: \`${version}\`\n\nClick **Start Bot** to launch!`,
          embeds: [buildUserEmbed(userId)],
          components: [botControlRow(userId), botControlRow2(userId)],
          ephemeral: true,
        });
        return;
      }
    }
  });

  await client.login(token);
}
