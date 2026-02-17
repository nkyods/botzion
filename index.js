process.on("unhandledRejection", console.error);

require("dotenv").config();
console.log("TOKEN carregou?", process.env.TOKEN ? "SIM" : "NÃO");
console.log("TOKEN começo:", (process.env.TOKEN || "").slice(0, 10));

const mongoose = require("mongoose");

// ✅ EXPRESS (Koyeb / Healthcheck)
const express = require("express");
const app = express();
app.get("/", (req, res) => res.send("Bot online ✅"));
app.listen(process.env.PORT || 8000, () => {
  console.log("🌐 Web server ligado na porta", process.env.PORT || 8000);
});

const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionsBitField,
  Events,
  MessageFlags,
} = require("discord.js");

// ============================
// MONGO CONEXÃO
// ============================
async function conectarMongo() {
  try {
    await mongoose.connect(process.env.MONGO_URI, { dbName: "bot_apostas" });
    console.log("✅ MongoDB conectado!");
  } catch (err) {
    console.log("❌ Erro ao conectar MongoDB:", err);
    process.exit(1);
  }
}

// ============================
// MODELS (Mongo / Mongoose)
// ============================

// PERFIL (por guild + user)
const PerfilSchema = new mongoose.Schema(
  {
    guildId: { type: String, index: true },
    userId: { type: String, index: true },
    vitorias: { type: Number, default: 0 },
    derrotas: { type: Number, default: 0 },
  },
  { timestamps: true }
);
PerfilSchema.index({ guildId: 1, userId: 1 }, { unique: true });
const Perfil = mongoose.model("Perfil", PerfilSchema);

// ESTADO DO SERVIDOR (fila mediadores)
const GuildEstadoSchema = new mongoose.Schema(
  {
    guildId: { type: String, unique: true },
    filaMediadores: { type: [String], default: [] },
  },
  { timestamps: true }
);
const GuildEstado = mongoose.model("GuildEstado", GuildEstadoSchema);

// PARTIDA (por canal) + confirmados (persistente)
const PartidaSchema = new mongoose.Schema(
  {
    guildId: { type: String, index: true },
    channelId: { type: String, unique: true },
    jogadores: { type: [String], default: [] },
    mediador: { type: String, required: true },
    valor: { type: Number, required: true },
    total: { type: Number, required: true },
    status: { type: String, default: "confirmacao" }, // confirmacao | em_andamento | finalizada
    confirmados: { type: [String], default: [] }, // ✅ mantém após restart
  },
  { timestamps: true }
);
const Partida = mongoose.model("Partida", PartidaSchema);

// PIX (por guild + user)
const PixSchema = new mongoose.Schema(
  {
    guildId: { type: String, index: true },
    userId: { type: String, index: true },
    chave: { type: String, required: true },
  },
  { timestamps: true }
);
PixSchema.index({ guildId: 1, userId: 1 }, { unique: true });
const Pix = mongoose.model("Pix", PixSchema);

// FILAS AP (mensagens) + jogadores (persistente)
const FilaAPSchema = new mongoose.Schema(
  {
    guildId: { type: String, index: true },
    channelId: { type: String, index: true },
    messageId: { type: String, unique: true },
    formato: { type: String, required: true },
    valor: { type: Number, required: true },
    jogadores: { type: [String], default: [] },
  },
  { timestamps: true }
);
const FilaAP = mongoose.model("FilaAP", FilaAPSchema);

// ============================
// FUNÇÕES DB
// ============================

async function garantirPerfilDB(guildId, userId) {
  return await Perfil.findOneAndUpdate(
    { guildId, userId },
    { $setOnInsert: { vitorias: 0, derrotas: 0 } },
    { new: true, upsert: true }
  );
}
async function adicionarVitoriaDB(guildId, userId) {
  await Perfil.updateOne({ guildId, userId }, { $inc: { vitorias: 1 } }, { upsert: true });
}
async function adicionarDerrotaDB(guildId, userId) {
  await Perfil.updateOne({ guildId, userId }, { $inc: { derrotas: 1 } }, { upsert: true });
}

async function getFilaMediadoresDB(guildId) {
  const estado = await GuildEstado.findOneAndUpdate(
    { guildId },
    { $setOnInsert: { filaMediadores: [] } },
    { new: true, upsert: true }
  );
  return estado.filaMediadores;
}
async function setFilaMediadoresDB(guildId, fila) {
  await GuildEstado.updateOne({ guildId }, { $set: { filaMediadores: fila } }, { upsert: true });
}
async function pushMediadorFimDB(guildId, mediadorId) {
  const fila = await getFilaMediadoresDB(guildId);
  const nova = fila.filter((id) => id !== mediadorId);
  nova.push(mediadorId);
  await setFilaMediadoresDB(guildId, nova);
  return nova;
}
async function shiftMediadorDB(guildId) {
  const fila = await getFilaMediadoresDB(guildId);
  const primeiro = fila.shift();
  await setFilaMediadoresDB(guildId, fila);
  return primeiro || null;
}

async function salvarPartidaDB({ guildId, channelId, jogadores, mediador, valor, total, status }) {
  await Partida.findOneAndUpdate(
    { channelId },
    { guildId, channelId, jogadores, mediador, valor, total, status, confirmados: [] },
    { upsert: true, new: true }
  );
}
async function getPartidaDB(channelId) {
  return await Partida.findOne({ channelId });
}
async function apagarPartidaDB(channelId) {
  await Partida.deleteOne({ channelId });
}

async function setPixDB(guildId, userId, chave) {
  await Pix.updateOne({ guildId, userId }, { $set: { chave } }, { upsert: true });
}
async function getPixDB(guildId, userId) {
  const doc = await Pix.findOne({ guildId, userId });
  return doc?.chave || null;
}

// FILA AP helpers
async function criarFilaAPDB({ guildId, channelId, messageId, formato, valor }) {
  await FilaAP.create({ guildId, channelId, messageId, formato, valor, jogadores: [] });
}
async function getFilaAPDBByMessageId(messageId) {
  return await FilaAP.findOne({ messageId });
}
async function addJogadorFilaAPDB(messageId, userId) {
  return await FilaAP.findOneAndUpdate({ messageId }, { $addToSet: { jogadores: userId } }, { new: true });
}
async function removeJogadorFilaAPDB(messageId, userId) {
  return await FilaAP.findOneAndUpdate({ messageId }, { $pull: { jogadores: userId } }, { new: true });
}
async function resetJogadoresFilaAPDB(messageId) {
  return await FilaAP.findOneAndUpdate({ messageId }, { $set: { jogadores: [] } }, { new: true });
}

// ============================
// DISCORD CLIENT
// ============================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel],
});
client.on("error", console.error);

// ====== CONFIG ======
const NOME_CARGO_MEDIADOR = "Mediador"; // nome EXATO do cargo

// ✅ cache em memória só pra performance (mas estado real fica no DB)
const filasCache = new Map(); // messageId -> { formato, valor }

// ============================
// HELPERS (EMBEDS)
// ============================
function embedFilaAP({ formato, valor, jogadores }) {
  const lista =
    jogadores.length > 0 ? jogadores.map((id) => `<@${id}>`).join(" | ") : "Nenhum jogador na fila.";

  return new EmbedBuilder()
    .setTitle("👑 JOGUE NA ORG ALFA!")
    .setDescription(`🎮 **Formato**\n${formato}\n\n💰 **Valor**\nR$ ${valor},00\n\n👥 **Jogadores**\n${lista}`)
    .setColor("#1e90ff");
}

function componentsFilaAP({ valor, formato }) {
  const gelNormal = new ButtonBuilder()
    .setCustomId(`normal_${valor}_${formato}`)
    .setLabel("🧊 Gel Normal")
    .setStyle(ButtonStyle.Primary);

  const gelInfinito = new ButtonBuilder()
    .setCustomId(`infinito_${valor}_${formato}`)
    .setLabel("🧊 Gel Infinito")
    .setStyle(ButtonStyle.Secondary);

  const sair = new ButtonBuilder()
    .setCustomId(`sair_${valor}_${formato}`)
    .setLabel("❌ Sair da Fila")
    .setStyle(ButtonStyle.Danger);

  return [new ActionRowBuilder().addComponents(gelNormal, gelInfinito, sair)];
}

function eph(content) {
  return { content, flags: MessageFlags.Ephemeral };
}

// ============================
// READY
// ============================
client.once(Events.ClientReady, async () => {
  await conectarMongo();
  console.log(`✅ Logado como ${client.user.tag}`);

  const commands = [
    { name: "painel", description: "Abrir painel de criação de filas" },
    { name: "registrarpix", description: "Registrar sua chave PIX" },
    { name: "med", description: "Painel de mediadores (apenas staff)" },
    {
      name: "limpar",
      description: "Apagar mensagens do canal",
      options: [
        { name: "quantidade", description: "Quantidade de mensagens para apagar (1-100)", type: 4, required: true },
      ],
    },
    {
      name: "p",
      description: "Ver perfil/estatísticas (vitórias, derrotas e partidas)",
      options: [{ name: "usuario", description: "Escolha um usuário", type: 6, required: false }],
    },
  ];

  // ✅ comandos globais (serve pra qualquer servidor que adicionar o bot)
  await client.application.commands.set(commands);
  console.log("✅ Comandos registrados (globais).");

  // ✅ Recarrega FILAS AP (pra botões voltarem a funcionar após restart)
  const filasDB = await FilaAP.find({});
  for (const f of filasDB) {
    filasCache.set(f.messageId, { formato: f.formato, valor: String(f.valor) });
  }
  console.log(`✅ Filas AP recuperadas do DB: ${filasDB.length}`);

  // ✅ Recupera PARTIDAS após restart
  const partidas = await Partida.find({ status: { $ne: "finalizada" } });
  for (const p of partidas) {
    const guild = await client.guilds.fetch(p.guildId).catch(() => null);
    if (!guild) continue;

    const canal = await guild.channels.fetch(p.channelId).catch(() => null);
    if (!canal) {
      await apagarPartidaDB(p.channelId);
      continue;
    }

    await canal.send("🤖 Reiniciei e recuperei esta partida do banco. Continuem normalmente.");
  }
});

// ============================
// INTERACTIONS
// ============================
client.on(Events.InteractionCreate, async (interaction) => {
  // ==========================
  // SLASH COMMANDS
  // ==========================
  if (interaction.isChatInputCommand()) {
    // /p
    if (interaction.commandName === "p") {
      if (!interaction.guildId) return interaction.reply(eph("Esse comando só funciona no servidor."));

      const alvo = interaction.options.getUser("usuario") || interaction.user;
      const perfil = await garantirPerfilDB(interaction.guildId, alvo.id);
      const partidas = (perfil.vitorias || 0) + (perfil.derrotas || 0);

      const embed = new EmbedBuilder()
        .setTitle("📊 Perfil do Jogador")
        .setDescription(`👤 **Usuário:** <@${alvo.id}>`)
        .addFields(
          { name: "🏆 Vitórias", value: String(perfil.vitorias), inline: true },
          { name: "💀 Derrotas", value: String(perfil.derrotas), inline: true },
          { name: "🎮 Partidas", value: String(partidas), inline: true }
        )
        .setColor("#7C3AED")
        .setTimestamp();

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // /limpar
    if (interaction.commandName === "limpar") {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
        return interaction.reply(eph("❌ Você não tem permissão."));
      }

      const quantidade = interaction.options.getInteger("quantidade");
      if (quantidade < 1 || quantidade > 100) return interaction.reply(eph("⚠️ Escolha um número entre 1 e 100."));

      await interaction.channel.bulkDelete(quantidade, true);
      return interaction.reply(eph(`🧹 ${quantidade} mensagens apagadas.`));
    }

    // /painel
    if (interaction.commandName === "painel") {
      const menu = new StringSelectMenuBuilder()
        .setCustomId("menu_painel")
        .setPlaceholder("Selecione uma opção")
        .addOptions([{ label: "Criar Fila AP", value: "criar_fila_ap" }]);

      return interaction.reply({
        content: "Painel de Controle:",
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: MessageFlags.Ephemeral,
      });
    }

    // /registrarpix
    if (interaction.commandName === "registrarpix") {
      const modal = new ModalBuilder().setCustomId("modal_pix").setTitle("Registrar Chave PIX");

      const input = new TextInputBuilder()
        .setCustomId("pix_input")
        .setLabel("Digite sua chave PIX")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }

    // /med
    if (interaction.commandName === "med") {
      if (!interaction.guild) return interaction.reply(eph("Esse comando só pode ser usado no servidor."));

      const membro = await interaction.guild.members.fetch(interaction.user.id);
      const cargo = membro.roles.cache.find((r) => r.name === NOME_CARGO_MEDIADOR);
      if (!cargo) return interaction.reply(eph("❌ Você não tem permissão para usar este comando."));

      const filaMeds = await getFilaMediadoresDB(interaction.guildId);

      const embed = new EmbedBuilder()
        .setTitle("🎧 Painel de Mediadores")
        .setDescription(
          filaMeds.length > 0 ? filaMeds.map((id, i) => `${i + 1}. <@${id}>`).join("\n") : "Nenhum mediador disponível."
        )
        .setColor("Green")
        .setFooter({ text: "Sistema de Mediação" });

      const entrar = new ButtonBuilder().setCustomId("med_entrar").setLabel("Entrar na Fila").setStyle(ButtonStyle.Success);
      const sair = new ButtonBuilder().setCustomId("med_sair").setLabel("Sair da Fila").setStyle(ButtonStyle.Danger);

      return interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(entrar, sair)] });
    }
  }

  // ==========================
  // SELECT MENUS
  // ==========================
  if (interaction.isStringSelectMenu()) {
    // Painel -> criar fila
    if (interaction.customId === "menu_painel") {
      if (interaction.values[0] === "criar_fila_ap") {
        const modal = new ModalBuilder().setCustomId("modal_criar_fila").setTitle("Criar Fila AP");

        const formatoInput = new TextInputBuilder()
          .setCustomId("formato_input")
          .setLabel("Formato (ex: 1v1, 2v2)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const valoresInput = new TextInputBuilder()
          .setCustomId("valores_input")
          .setLabel("Valores (ex: 100 50 20 10)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        modal.addComponents(
          new ActionRowBuilder().addComponents(formatoInput),
          new ActionRowBuilder().addComponents(valoresInput)
        );

        return interaction.showModal(modal);
      }
      return;
    }

    // Menu do mediador
    if (interaction.customId === "menu_mediador") {
      const dados = await getPartidaDB(interaction.channel.id);
      if (!dados) return interaction.reply(eph("⚠️ Essa partida não existe mais."));

      if (interaction.user.id !== dados.mediador) return interaction.reply(eph("❌ Apenas o mediador pode usar este menu."));

      const escolha = interaction.values[0];

      // finalizar
      if (escolha === "finalizar_aposta") {
        await interaction.reply(eph("🔚 Aposta finalizada. Fechando canal..."));

        await pushMediadorFimDB(interaction.guildId, dados.mediador);

        await Partida.updateOne({ channelId: interaction.channel.id }, { $set: { status: "finalizada" } });
        await apagarPartidaDB(interaction.channel.id);

        return setTimeout(() => interaction.channel.delete().catch(() => {}), 2000);
      }

      // wo/vencedor
      if (escolha === "wo_menu" || escolha === "vencedor_menu") {
        const tipo = escolha === "wo_menu" ? "wo" : "vencedor";

        const selectJogador = new StringSelectMenuBuilder()
          .setCustomId(`escolher_jogador_${tipo}`)
          .setPlaceholder("Selecionar jogador")
          .addOptions([
            { label: interaction.guild.members.cache.get(dados.jogadores[0])?.user.username || "Jogador 1", value: dados.jogadores[0] },
            { label: interaction.guild.members.cache.get(dados.jogadores[1])?.user.username || "Jogador 2", value: dados.jogadores[1] },
          ]);

        return interaction.reply({
          content: `Selecione quem ${tipo === "wo" ? "venceu por WO" : "venceu"}:`,
          components: [new ActionRowBuilder().addComponents(selectJogador)],
          flags: MessageFlags.Ephemeral,
        });
      }

      return;
    }

    // escolher jogador (wo/vencedor)
    if (interaction.customId.startsWith("escolher_jogador_")) {
      const dados = await getPartidaDB(interaction.channel.id);
      if (!dados) return interaction.reply(eph("⚠️ Essa partida não existe mais."));

      if (interaction.user.id !== dados.mediador) return interaction.reply(eph("❌ Apenas o mediador pode usar isso."));

      const tipo = interaction.customId.split("escolher_jogador_")[1];
      const vencedorId = interaction.values[0];

      await adicionarVitoriaDB(interaction.guildId, vencedorId);
      for (const id of dados.jogadores) {
        if (id === vencedorId) continue;
        await adicionarDerrotaDB(interaction.guildId, id);
      }

      await interaction.update({
        content: `✅ Resultado definido (${tipo.toUpperCase()})!\n🏆 Vencedor: <@${vencedorId}>`,
        components: [],
      });

      await interaction.channel.send(`🎉 <@${vencedorId}> venceu!\n💰 Total da aposta: R$ ${dados.total},00`);

      await pushMediadorFimDB(interaction.guildId, dados.mediador);

      await Partida.updateOne({ channelId: interaction.channel.id }, { $set: { status: "finalizada" } });
      await apagarPartidaDB(interaction.channel.id);

      return setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
    }
  }

  // ==========================
  // MODALS
  // ==========================
  if (interaction.isModalSubmit()) {
    // PIX (persistente)
    if (interaction.customId === "modal_pix") {
      if (!interaction.guildId) return interaction.reply(eph("Esse comando só funciona no servidor."));
      const chave = interaction.fields.getTextInputValue("pix_input");
      await setPixDB(interaction.guildId, interaction.user.id, chave);
      return interaction.reply(eph("✅ Chave PIX registrada com sucesso."));
    }

    // criar fila AP (persistente)
    if (interaction.customId === "modal_criar_fila") {
      if (!interaction.guildId) return interaction.reply(eph("Esse comando só funciona no servidor."));

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const formato = interaction.fields.getTextInputValue("formato_input");
      const valores = interaction.fields.getTextInputValue("valores_input");
      const listaValores = valores
        .split(" ")
        .map((v) => v.trim())
        .filter(Boolean);

      for (const v of listaValores) {
        const valor = Number(v);
        if (!Number.isFinite(valor) || valor <= 0) continue;

        const embed = embedFilaAP({ formato, valor, jogadores: [] });
        const msg = await interaction.channel.send({
          embeds: [embed],
          components: componentsFilaAP({ valor, formato }),
        });

        await criarFilaAPDB({
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          messageId: msg.id,
          formato,
          valor,
        });

        filasCache.set(msg.id, { formato, valor: String(valor) });
      }

      return interaction.editReply("✅ Filas criadas com sucesso.");
    }
  }

  // ==========================
  // BUTTONS
  // ==========================
  if (interaction.isButton()) {
    // mediador entrar
    if (interaction.customId === "med_entrar") {
      const fila = await getFilaMediadoresDB(interaction.guildId);

      if (fila.includes(interaction.user.id)) return interaction.reply(eph("Você já está na fila de mediadores."));

      fila.push(interaction.user.id);
      await setFilaMediadoresDB(interaction.guildId, fila);

      const embedAtualizado = new EmbedBuilder()
        .setTitle("🎧 Painel de Mediadores")
        .setDescription(
          fila.length > 0 ? fila.map((id, i) => `${i + 1}. <@${id}>`).join("\n") : "Nenhum mediador disponível."
        )
        .setColor("Green")
        .setFooter({ text: "Sistema de Mediação" });

      return interaction.update({ embeds: [embedAtualizado] });
    }

    // mediador sair
    if (interaction.customId === "med_sair") {
      const fila = await getFilaMediadoresDB(interaction.guildId);

      const idx = fila.indexOf(interaction.user.id);
      if (idx === -1) return interaction.reply(eph("Você não está na fila."));

      fila.splice(idx, 1);
      await setFilaMediadoresDB(interaction.guildId, fila);

      const embedAtualizado = new EmbedBuilder()
        .setTitle("🎧 Painel de Mediadores")
        .setDescription(
          fila.length > 0 ? fila.map((id, i) => `${i + 1}. <@${id}>`).join("\n") : "Nenhum mediador disponível."
        )
        .setColor("Green")
        .setFooter({ text: "Sistema de Mediação" });

      return interaction.update({ embeds: [embedAtualizado] });
    }

    // ==========================
    // ENTRAR FILA AP (normal/infinito)
    // ==========================
    if (interaction.customId.startsWith("normal_") || interaction.customId.startsWith("infinito_")) {
      const messageId = interaction.message.id;

      // tenta no cache; se não tiver (restart), busca do DB
      let filaInfo = filasCache.get(messageId);
      let filaDoc = await getFilaAPDBByMessageId(messageId);

      if (!filaDoc) return interaction.reply(eph("⚠️ Essa fila não existe mais (ou não foi salva no banco)."));

      if (!filaInfo) {
        filaInfo = { formato: filaDoc.formato, valor: String(filaDoc.valor) };
        filasCache.set(messageId, filaInfo);
      }

      if (filaDoc.jogadores.includes(interaction.user.id)) {
        return interaction.reply(eph("Você já está na fila."));
      }

      filaDoc = await addJogadorFilaAPDB(messageId, interaction.user.id);

      // atualiza embed
      await interaction.update({
        embeds: [embedFilaAP({ formato: filaDoc.formato, valor: filaDoc.valor, jogadores: filaDoc.jogadores })],
        components: componentsFilaAP({ valor: filaDoc.valor, formato: filaDoc.formato }),
      });

      const quantidadeNecessaria = parseInt(filaDoc.formato.split("v")[0]) * 2;

      if (filaDoc.jogadores.length === quantidadeNecessaria) {
        const mediadorId = await shiftMediadorDB(interaction.guildId);
        if (!mediadorId) {
          // desfaz entrada do último
          await removeJogadorFilaAPDB(messageId, interaction.user.id);

          // recarrega e atualiza mensagem
          const doc2 = await getFilaAPDBByMessageId(messageId);
          await interaction.message.edit({
            embeds: [embedFilaAP({ formato: doc2.formato, valor: doc2.valor, jogadores: doc2.jogadores })],
            components: componentsFilaAP({ valor: doc2.valor, formato: doc2.formato }),
          });

          return interaction.followUp({ ...eph("❌ Não há mediadores disponíveis no momento.") });
        }

        const donoServidor = interaction.guild.ownerId;

        const valorNumero = Number(filaDoc.valor);
        const totalPartida = valorNumero * quantidadeNecessaria;

        const canal = await interaction.guild.channels.create({
          name: `ap-${valorNumero}`,
          type: ChannelType.GuildText,
          permissionOverwrites: [
            { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
            { id: donoServidor, allow: [PermissionsBitField.Flags.ViewChannel] },
            { id: mediadorId, allow: [PermissionsBitField.Flags.ViewChannel] },
            ...filaDoc.jogadores.map((id) => ({ id, allow: [PermissionsBitField.Flags.ViewChannel] })),
          ],
        });

        await salvarPartidaDB({
          guildId: interaction.guildId,
          channelId: canal.id,
          jogadores: filaDoc.jogadores,
          mediador: mediadorId,
          valor: valorNumero,
          total: totalPartida,
          status: "confirmacao",
        });

        const pix = await getPixDB(interaction.guildId, mediadorId);

        const embedConfirmacao = new EmbedBuilder()
          .setTitle("🎮 Partida Encontrada!")
          .setDescription(
            `👥 **Jogadores:**\n${filaDoc.jogadores.map((id) => `<@${id}>`).join("\n")}\n\n` +
              `🎧 **Mediador:**\n<@${mediadorId}>\n\n` +
              `💰 **Valor:**\nR$ ${valorNumero},00\n\n` +
              `💳 **PIX do Mediador:**\n\`\`\`\n${pix || "Mediador ainda não registrou PIX"}\n\`\`\`\n\n` +
              `⚠️ Ambos jogadores devem confirmar abaixo.`
          )
          .setColor("Green");

        const confirmar = new ButtonBuilder()
          .setCustomId("confirmar_partida")
          .setLabel("✅ Confirmar")
          .setStyle(ButtonStyle.Success);

        await canal.send({
          content: `<@${mediadorId}>`,
          embeds: [embedConfirmacao],
          components: [new ActionRowBuilder().addComponents(confirmar)],
        });

        await interaction.followUp({ content: `✅ Partida criada: ${canal}`, flags: MessageFlags.Ephemeral });

        // ✅ reset fila no DB e na mensagem
        const docReset = await resetJogadoresFilaAPDB(messageId);
        await interaction.message.edit({
          embeds: [embedFilaAP({ formato: docReset.formato, valor: docReset.valor, jogadores: [] })],
          components: componentsFilaAP({ valor: docReset.valor, formato: docReset.formato }),
        });
      }

      return;
    }

    // ==========================
    // SAIR DA FILA AP
    // ==========================
    if (interaction.customId.startsWith("sair_")) {
      const messageId = interaction.message.id;
      const filaDoc = await getFilaAPDBByMessageId(messageId);
      if (!filaDoc) return interaction.reply(eph("⚠️ Essa fila não existe mais."));

      if (!filaDoc.jogadores.includes(interaction.user.id)) {
        return interaction.reply(eph("Você não está nessa fila."));
      }

      const novo = await removeJogadorFilaAPDB(messageId, interaction.user.id);

      return interaction.update({
        embeds: [embedFilaAP({ formato: novo.formato, valor: novo.valor, jogadores: novo.jogadores })],
        components: componentsFilaAP({ valor: novo.valor, formato: novo.formato }),
      });
    }

    // ==========================
    // CONFIRMAR PARTIDA (persistente)
    // ==========================
    if (interaction.customId === "confirmar_partida") {
      const canalId = interaction.channel.id;
      const dados = await getPartidaDB(canalId);
      if (!dados) return interaction.reply(eph("⚠️ Essa partida não existe mais."));

      if (!dados.jogadores.includes(interaction.user.id)) {
        return interaction.reply(eph("❌ Apenas jogadores podem confirmar."));
      }

      // se já confirmou
      if (dados.confirmados?.includes(interaction.user.id)) {
        return interaction.reply(eph("⚠️ Você já confirmou."));
      }

      // ✅ grava no DB
      const upd = await Partida.findOneAndUpdate(
        { channelId: canalId },
        { $addToSet: { confirmados: interaction.user.id } },
        { new: true }
      );

      await interaction.reply(eph("✅ Confirmação registrada."));

      if (upd.confirmados.length === upd.jogadores.length) {
        await interaction.channel.setName(`pagar-${upd.total}`);
        await interaction.channel.send(`🔥 Ambos jogadores confirmaram!\n💰 Valor total: R$ ${upd.total},00`);

        await Partida.updateOne({ channelId: canalId }, { $set: { status: "em_andamento" } });

        const select = new StringSelectMenuBuilder()
          .setCustomId("menu_mediador")
          .setPlaceholder("Selecionar ação")
          .addOptions([
            { label: "Vitória por WO", emoji: "🚫", value: "wo_menu" },
            { label: "Escolher vencedor", emoji: "🏆", value: "vencedor_menu" },
            { label: "Finalizar aposta", emoji: "🔚", value: "finalizar_aposta" },
          ]);

        await interaction.channel.send({
          content: `🎧 <@${upd.mediador}> painel do mediador:`,
          components: [new ActionRowBuilder().addComponents(select)],
        });
      }

      return;
    }
  }
});

// ✅ SEMPRE token no .env
client.login(process.env.TOKEN);



