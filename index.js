process.on("unhandledRejection", console.error);

require("dotenv").config();
const mongoose = require("mongoose");

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
  Events
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

// ESTADO DO SERVIDOR (fila mediadores etc)
const GuildEstadoSchema = new mongoose.Schema(
  {
    guildId: { type: String, unique: true },
    filaMediadores: { type: [String], default: [] },
  },
  { timestamps: true }
);
const GuildEstado = mongoose.model("GuildEstado", GuildEstadoSchema);

// PARTIDA (por canal)
const PartidaSchema = new mongoose.Schema(
  {
    guildId: { type: String, index: true },
    channelId: { type: String, unique: true },
    jogadores: { type: [String], default: [] },
    mediador: { type: String, required: true },
    valor: { type: Number, required: true },
    total: { type: Number, required: true },
    status: { type: String, default: "confirmacao" }, // confirmacao | em_andamento | finalizada
  },
  { timestamps: true }
);
const Partida = mongoose.model("Partida", PartidaSchema);

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
    { guildId, channelId, jogadores, mediador, valor, total, status },
    { upsert: true, new: true }
  );
}

async function getPartidaDB(channelId) {
  return await Partida.findOne({ channelId });
}

async function apagarPartidaDB(channelId) {
  await Partida.deleteOne({ channelId });
}

// ============================
// DISCORD CLIENT
// ============================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel],
});

client.on("error", console.error);

// ====== SISTEMAS GLOBAIS ======
const NOME_CARGO_MEDIADOR = "Mediador"; // nome EXATO
const filas = new Map(); // filas AP (memória). (Se reiniciar, mensagens antigas não ficam "vivas" - normal)
const CONFIRMACOES_PARTIDA = new Map(); // canalId -> Set(userId)
const pixData = {}; // em memória (se quiser persistir no mongo depois a gente faz)

// ============================
// READY
// ============================
client.once(Events.ClientReady, async () => {
  await conectarMongo();
  console.log(`Logado como ${client.user.tag}`);

  const commands = [
    { name: "painel", description: "Abrir painel de criação de filas" },
    { name: "registrarpix", description: "Registrar sua chave PIX" },
    { name: "med", description: "Painel de mediadores (apenas staff)" },
    {
      name: "limpar",
      description: "Apagar mensagens do canal",
      options: [
        {
          name: "quantidade",
          description: "Quantidade de mensagens para apagar (1-100)",
          type: 4,
          required: true,
        },
      ],
    },
    {
      name: "p",
      description: "Ver perfil/estatísticas (vitórias, derrotas e partidas)",
      options: [
        {
          name: "usuario",
          description: "Escolha um usuário (se não escolher, mostra o seu)",
          type: 6,
          required: false,
        },
      ],
    },
  ];

  // ✅ comandos globais
  await client.application.commands.set(commands);
  console.log("✅ Comandos registrados (globais).");

  // ============================
  // RECUPERAR PARTIDAS APÓS RESTART
  // ============================
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
  // ============================
  // SLASH COMMANDS
  // ============================
  if (interaction.isChatInputCommand()) {
    // /p
    if (interaction.commandName === "p") {
      if (!interaction.guildId) {
        return interaction.reply({ content: "Esse comando só funciona no servidor.", ephemeral: true });
      }

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

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // /limpar
    if (interaction.commandName === "limpar") {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
        return interaction.reply({ content: "❌ Você não tem permissão.", ephemeral: true });
      }

      const quantidade = interaction.options.getInteger("quantidade");
      if (quantidade < 1 || quantidade > 100) {
        return interaction.reply({ content: "⚠️ Escolha um número entre 1 e 100.", ephemeral: true });
      }

      await interaction.channel.bulkDelete(quantidade, true);
      return interaction.reply({ content: `🧹 ${quantidade} mensagens apagadas.`, ephemeral: true });
    }

    // /painel
    if (interaction.commandName === "painel") {
      const menu = new StringSelectMenuBuilder()
        .setCustomId("menu_painel")
        .setPlaceholder("Selecione uma opção")
        .addOptions([{ label: "Criar Fila AP", value: "criar_fila_ap" }]);

      const row = new ActionRowBuilder().addComponents(menu);

      return interaction.reply({
        content: "Painel de Controle:",
        components: [row],
        ephemeral: true,
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
      if (!interaction.guild) {
        return interaction.reply({ content: "Esse comando só pode ser usado no servidor.", ephemeral: true });
      }

      const membro = await interaction.guild.members.fetch(interaction.user.id);
      const cargo = membro.roles.cache.find((r) => r.name === NOME_CARGO_MEDIADOR);

      if (!cargo) {
        return interaction.reply({ content: "❌ Você não tem permissão para usar este comando.", ephemeral: true });
      }

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

      const row = new ActionRowBuilder().addComponents(entrar, sair);

      return interaction.reply({ embeds: [embed], components: [row] });
    }
  }

  // ============================
  // SELECT MENUS
  // ============================
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

    // Menu do mediador (principal)
    if (interaction.customId === "menu_mediador") {
      const dados = await getPartidaDB(interaction.channel.id);
      if (!dados) return interaction.reply({ content: "⚠️ Essa partida não existe mais.", ephemeral: true });

      if (interaction.user.id !== dados.mediador) {
        return interaction.reply({ content: "❌ Apenas o mediador pode usar este menu.", ephemeral: true });
      }

      const escolha = interaction.values[0];

      // finalizar
      if (escolha === "finalizar_aposta") {
        await interaction.reply({ content: "🔚 Aposta finalizada. Fechando canal...", ephemeral: true });

        await pushMediadorFimDB(interaction.guildId, dados.mediador);
        CONFIRMACOES_PARTIDA.delete(interaction.channel.id);

        await Partida.updateOne({ channelId: interaction.channel.id }, { $set: { status: "finalizada" } });
        await apagarPartidaDB(interaction.channel.id);

        return setTimeout(() => interaction.channel.delete().catch(() => {}), 2000);
      }

      // abre menu de jogador
      if (escolha === "wo_menu" || escolha === "vencedor_menu") {
        const tipo = escolha === "wo_menu" ? "wo" : "vencedor";

        const selectJogador = new StringSelectMenuBuilder()
          .setCustomId(`escolher_jogador_${tipo}`)
          .setPlaceholder("Selecionar jogador")
          .addOptions([
            { label: interaction.guild.members.cache.get(dados.jogadores[0])?.user.username || "Jogador 1", value: dados.jogadores[0] },
            { label: interaction.guild.members.cache.get(dados.jogadores[1])?.user.username || "Jogador 2", value: dados.jogadores[1] },
          ]);

        const rowJogador = new ActionRowBuilder().addComponents(selectJogador);

        return interaction.reply({
          content: `Selecione quem ${tipo === "wo" ? "venceu por WO" : "venceu"}:`,
          components: [rowJogador],
          ephemeral: true,
        });
      }

      return;
    }

    // Escolher jogador (wo/vencedor)
    if (interaction.customId.startsWith("escolher_jogador_")) {
      const dados = await getPartidaDB(interaction.channel.id);
      if (!dados) return interaction.reply({ content: "⚠️ Essa partida não existe mais.", ephemeral: true });

      if (interaction.user.id !== dados.mediador) {
        return interaction.reply({ content: "❌ Apenas o mediador pode usar isso.", ephemeral: true });
      }

      const tipo = interaction.customId.split("escolher_jogador_")[1];
      const vencedorId = interaction.values[0];

      // stats
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
      CONFIRMACOES_PARTIDA.delete(interaction.channel.id);

      await Partida.updateOne({ channelId: interaction.channel.id }, { $set: { status: "finalizada" } });
      await apagarPartidaDB(interaction.channel.id);

      return setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
    }
  }

  // ============================
  // MODALS
  // ============================
  if (interaction.isModalSubmit()) {
    // pix
    if (interaction.customId === "modal_pix") {
      const chave = interaction.fields.getTextInputValue("pix_input");
      pixData[interaction.user.id] = chave;
      return interaction.reply({ content: "✅ Chave PIX registrada com sucesso.", ephemeral: true });
    }

    // criar fila
    if (interaction.customId === "modal_criar_fila") {
      await interaction.deferReply({ ephemeral: true });

      const formato = interaction.fields.getTextInputValue("formato_input");
      const valores = interaction.fields.getTextInputValue("valores_input");
      const listaValores = valores.split(" ").filter((v) => v.trim().length);

      for (const valor of listaValores) {
        const embed = new EmbedBuilder()
          .setTitle("👑 JOGUE NA ORG ALFA!")
          .setDescription(
            `🎮 **Formato**\n${formato}\n\n💰 **Valor**\nR$ ${valor},00\n\n👥 **Jogadores**\nNenhum jogador na fila.`
          )
          .setColor("#1e90ff");

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

        const row = new ActionRowBuilder().addComponents(gelNormal, gelInfinito, sair);

        const mensagem = await interaction.channel.send({ embeds: [embed], components: [row] });

        filas.set(mensagem.id, { valor, formato, jogadores: [], messageId: mensagem.id });
      }

      return interaction.editReply("✅ Filas criadas com sucesso.");
    }
  }

  // ============================
  // BUTTONS
  // ============================
  if (interaction.isButton()) {
    // mediadores entrar
    if (interaction.customId === "med_entrar") {
      const fila = await getFilaMediadoresDB(interaction.guildId);

      if (fila.includes(interaction.user.id)) {
        return interaction.reply({ content: "Você já está na fila de mediadores.", ephemeral: true });
      }

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

    // mediadores sair
    if (interaction.customId === "med_sair") {
      const fila = await getFilaMediadoresDB(interaction.guildId);

      const idx = fila.indexOf(interaction.user.id);
      if (idx === -1) return interaction.reply({ content: "Você não está na fila.", ephemeral: true });

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

    // entrar fila (normal/infinito)
    if (interaction.customId.startsWith("normal_") || interaction.customId.startsWith("infinito_")) {
      const fila = filas.get(interaction.message.id);
      if (!fila) return;

      if (fila.jogadores.includes(interaction.user.id)) {
        return interaction.reply({ content: "Você já está na fila.", ephemeral: true });
      }

      fila.jogadores.push(interaction.user.id);

      const listaJogadores = fila.jogadores.map((id) => `<@${id}>`).join(" | ");

      const embedAtualizado = new EmbedBuilder()
        .setTitle("👑 JOGUE NA ORG ALFA!")
        .setDescription(
          `🎮 **Formato**\n${fila.formato}\n\n💰 **Valor**\nR$ ${fila.valor},00\n\n👥 **Jogadores**\n${listaJogadores}`
        )
        .setColor("#1e90ff");

      await interaction.update({ embeds: [embedAtualizado] });

      const quantidadeNecessaria = parseInt(fila.formato.split("v")[0]) * 2;

      if (fila.jogadores.length === quantidadeNecessaria) {
        const mediadorId = await shiftMediadorDB(interaction.guildId);
        if (!mediadorId) {
          fila.jogadores.pop();
          return interaction.followUp({ content: "❌ Não há mediadores disponíveis no momento.", ephemeral: true });
        }

        const donoServidor = interaction.guild.ownerId;

        const valorNumero = Number(fila.valor);
        const totalPartida = valorNumero * quantidadeNecessaria;

        const canal = await interaction.guild.channels.create({
          name: `ap-${valorNumero}`,
          type: ChannelType.GuildText,
          permissionOverwrites: [
            { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
            { id: donoServidor, allow: [PermissionsBitField.Flags.ViewChannel] },
            { id: mediadorId, allow: [PermissionsBitField.Flags.ViewChannel] },
            ...fila.jogadores.map((id) => ({ id, allow: [PermissionsBitField.Flags.ViewChannel] })),
          ],
        });

        await salvarPartidaDB({
          guildId: interaction.guildId,
          channelId: canal.id,
          jogadores: fila.jogadores,
          mediador: mediadorId,
          valor: valorNumero,
          total: totalPartida,
          status: "confirmacao",
        });

        const embedConfirmacao = new EmbedBuilder()
          .setTitle("🎮 Partida Encontrada!")
          .setDescription(
            `👥 **Jogadores:**\n${fila.jogadores.map((id) => `<@${id}>`).join("\n")}\n\n🎧 **Mediador:**\n<@${mediadorId}>\n\n💰 **Valor:**\nR$ ${fila.valor},00\n\n💳 **PIX do Mediador:**\n\`\`\`\n${pixData[mediadorId] || "Mediador ainda não registrou PIX"}\n\`\`\`\n\n⚠️ Ambos jogadores devem confirmar abaixo.`
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

        await interaction.followUp({ content: `✅ Partida criada: ${canal}` });

        // reset fila da mensagem
        fila.jogadores = [];

        const embedReset = new EmbedBuilder()
          .setTitle("👑 JOGUE NA ORG ALFA!")
          .setDescription(
            `🎮 **Formato**\n${fila.formato}\n\n💰 **Valor**\nR$ ${fila.valor},00\n\n👥 **Jogadores**\nNenhum jogador na fila.`
          )
          .setColor("#1e90ff");

        await interaction.message.edit({ embeds: [embedReset] });
      }

      return;
    }

    // sair fila
    if (interaction.customId.startsWith("sair_")) {
      const fila = filas.get(interaction.message.id);
      if (!fila) return;

      const idx = fila.jogadores.indexOf(interaction.user.id);
      if (idx === -1) return interaction.reply({ content: "Você não está nessa fila.", ephemeral: true });

      fila.jogadores.splice(idx, 1);

      const listaJogadores =
        fila.jogadores.length > 0 ? fila.jogadores.map((id) => `<@${id}>`).join(" | ") : "Nenhum jogador na fila.";

      const embedAtualizado = new EmbedBuilder()
        .setTitle("👑 JOGUE NA ORG ALFA!")
        .setDescription(
          `🎮 **Formato**\n${fila.formato}\n\n💰 **Valor**\nR$ ${fila.valor},00\n\n👥 **Jogadores**\n${listaJogadores}`
        )
        .setColor("#1e90ff");

      return interaction.update({ embeds: [embedAtualizado] });
    }

    // confirmar partida
    if (interaction.customId === "confirmar_partida") {
      const canalId = interaction.channel.id;
      const dados = await getPartidaDB(canalId);
      if (!dados) return;

      if (!dados.jogadores.includes(interaction.user.id)) {
        return interaction.reply({ content: "❌ Apenas jogadores podem confirmar.", ephemeral: true });
      }

      if (!CONFIRMACOES_PARTIDA.has(canalId)) {
        CONFIRMACOES_PARTIDA.set(canalId, new Set());
      }

      const confirmacoes = CONFIRMACOES_PARTIDA.get(canalId);
      if (confirmacoes.has(interaction.user.id)) {
        return interaction.reply({ content: "⚠️ Você já confirmou.", ephemeral: true });
      }

      confirmacoes.add(interaction.user.id);
      await interaction.reply({ content: "✅ Confirmação registrada.", ephemeral: true });

      if (confirmacoes.size === dados.jogadores.length) {
        await interaction.channel.setName(`pagar-${dados.total}`);

        await interaction.channel.send(`🔥 Ambos jogadores confirmaram!\n💰 Valor total: R$ ${dados.total},00`);

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
          content: `🎧 <@${dados.mediador}> painel do mediador:`,
          components: [new ActionRowBuilder().addComponents(select)],
        });
      }

      return;
    }
  }
});

client.login(process.env.TOKEN);
