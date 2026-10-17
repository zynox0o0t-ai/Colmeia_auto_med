/**
 * Colmeia Pix Bot — confirmação automática de pagamento nas filas
 * -------------------------------------------------
 * Bot SEPARADO do bot de filas (roda em outro processo / outro token).
 *
 * O que faz:
 *  - Vigia TODOS os tópicos criados no canal de filas (CANAL_FILAS_ID),
 *    sem limite de quantidade.
 *  - Quando o card "Regras Padrão" aparece num tópico, manda embaixo
 *    a mensagem de exemplo "PAGAMENTO VIA PIX".
 *  - Quando alguém escreve "pg / pago / paguei / att pago" + nome e
 *    sobrenome (ou nome + final do sobrenome) do Pix:
 *      1) "Verificando Pix..." (mostra o valor esperado)
 *      2) Pix encontrado -> "Pix confirmado 🟢" + nome completo do
 *         pagador + "esperando outro jogador" (x/y)
 *      3) Quando todos pagaram -> "Criando sala..."
 *    A cada etapa a mensagem anterior do bot é apagada.
 *  - Cada MEDIADOR cadastra a PRÓPRIA API no painel !painelapi
 *    (Cadastrar API, Gerar nova = substitui a antiga, Excluir API,
 *    Minha API = ver status). O bot só age nos tópicos cujo mediador
 *    tem API cadastrada; se não tem, fica em silêncio (nem a
 *    mensagem de exemplo aparece).
 *  - O mediador do tópico é lido do campo "Mediador:" da ficha da
 *    partida (a do bot de filas).
 *
 * Requisitos:  npm install discord.js   (Node 18+)
 *
 * Variáveis de ambiente:
 *   DISCORD_TOKEN_PIX     -> token deste bot (ou DISCORD_TOKEN)
 *   CANAL_FILAS_ID        -> canal onde os tópicos das filas são criados
 *   JOGADORES_POR_PARTIDA -> fallback se não achar a lista de jogadores
 *                            no tópico (padrão 2)
 *   JANELA_MINUTOS        -> até quantos minutos atrás procurar o Pix (30)
 *   MEDIADOR_ROLE_ID      -> cargo de mediador (quem pode cadastrar API;
 *                            vazio = qualquer pessoa). Admins sempre podem.
 *   DONO_USER_ID          -> ID de usuário com acesso ao painel sempre
 *   REGEX_REGRAS          -> regex do título do card de regras que
 *                            dispara a mensagem de exemplo
 *
 * Provedor de pagamento: Mercado Pago (Access Token). Só enxerga Pix
 * recebidos NA CONTA dona do token. Pra usar outro provedor (Efí,
 * Asaas...), troque só a função buscarPagamentosRecentes().
 *
 * Permissões do bot: Ver Canais, Enviar Mensagens, Gerenciar Mensagens,
 * Ver Histórico, Gerenciar Tópicos (pra ver tópicos privados).
 * Intents: Server Members não precisa; ative Message Content.
 */

const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionsBitField,
} = require('discord.js');
const fs = require('fs');
const path = require('path');

// ------------------- CONFIG -------------------
const TOKEN = process.env.DISCORD_TOKEN_PIX || process.env.DISCORD_TOKEN || 'SEU_TOKEN_AQUI';
const CANAL_FILAS_ID = process.env.CANAL_FILAS_ID || '1541242653532750005';
const JOGADORES_PADRAO = parseInt(process.env.JOGADORES_POR_PARTIDA || '2', 10);
const JANELA_MINUTOS = parseInt(process.env.JANELA_MINUTOS || '30', 10);
const DONO_USER_ID = process.env.DONO_USER_ID || '';
const MEDIADOR_ROLE_ID = process.env.MEDIADOR_ROLE_ID || '';
const REGEX_REGRAS = new RegExp(process.env.REGEX_REGRAS || 'regras padr', 'i');

const COR_AMARELA = 0xf1c40f;
const COR_VERDE = 0x2ecc71;
const COR_VERMELHA = 0xe74c3c;

// ------------------- DADOS (arquivo JSON) -------------------
// ⚠️ No Railway, use um Volume persistente, senão a API cadastrada
// some a cada reinício.
const CAMINHO_DADOS = path.join(__dirname, 'pix-dados.json');

function carregarDados() {
  try {
    const d = JSON.parse(fs.readFileSync(CAMINHO_DADOS, 'utf-8'));
    return { apis: d.apis || {}, usados: d.usados || [], partidas: d.partidas || {} };
  } catch (err) {
    return { apis: {}, usados: [], partidas: {} };
  }
}
const dados = carregarDados();

function salvarDados() {
  if (dados.usados.length > 2000) dados.usados = dados.usados.slice(-2000);
  fs.writeFileSync(CAMINHO_DADOS, JSON.stringify(dados, null, 2), 'utf-8');
}

// ------------------- UTIL -------------------
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function parseValor(texto) {
  if (!texto) return null;
  let t = String(texto).replace(/[^\d,\.]/g, '');
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(t);
  return isNaN(n) ? null : n;
}
function formatarValor(n) {
  return `R$ ${n.toFixed(2).replace('.', ',')}`;
}
function normalizar(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}
function tituloNome(nome) {
  return nome
    .toLowerCase()
    .split(/\s+/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

// Nome informado ("Daniel Campelo" / "Daniel pelo") x nome do pagador.
// Regra: primeiro nome igual + final do sobrenome batendo.
function nomeConfere(informado, pagador) {
  const a = normalizar(informado);
  const b = normalizar(pagador);
  if (a.length < 2 || b.length < 2) return false;
  if (!b[0].startsWith(a[0]) && !a[0].startsWith(b[0])) return false;
  const ultInf = a[a.length - 1];
  const ultPag = b[b.length - 1];
  if (ultInf.length < 2) return false;
  return ultPag.endsWith(ultInf) || b.slice(1).some((t) => t.endsWith(ultInf));
}

// Trava por tópico: evita dois "pg" ao mesmo tempo usarem o mesmo Pix.
const travas = new Map();
function comTrava(id, fn) {
  const anterior = travas.get(id) || Promise.resolve();
  const proxima = anterior.then(fn, fn).catch((e) => console.error('⚠️ Erro no tópico', id, e));
  travas.set(id, proxima);
  return proxima;
}

async function apagar(canal, msgId) {
  if (!msgId) return;
  await canal.messages.delete(msgId).catch(() => {});
}

// ------------------- PROVEDOR: MERCADO PAGO -------------------
async function validarApiMercadoPago(token) {
  const r = await fetch('https://api.mercadopago.com/users/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  return r.json();
}

// Retorna [{ id, valor, nome, quando }] dos Pix aprovados recentes.
async function buscarPagamentosRecentes(token, minutos) {
  const url =
    'https://api.mercadopago.com/v1/payments/search' +
    `?sort=date_created&criteria=desc&range=date_created` +
    `&begin_date=NOW-${minutos}MINUTES&end_date=NOW&status=approved&limit=50`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Mercado Pago respondeu ${r.status}`);
  const json = await r.json();

  return (json.results || [])
    .filter((p) => p.payment_method_id === 'pix')
    .map((p) => {
      const banco = p.point_of_interaction?.transaction_data?.bank_info?.payer || {};
      const pagador = p.payer || {};
      const extra = p.additional_info?.payer || {};
      const nome =
        banco.long_name ||
        [pagador.first_name, pagador.last_name].filter(Boolean).join(' ') ||
        [extra.first_name, extra.last_name].filter(Boolean).join(' ') ||
        '';
      return {
        id: String(p.id),
        valor: Number(p.transaction_amount),
        nome,
        quando: new Date(p.date_approved || p.date_created).getTime(),
      };
    });
}

// ------------------- EMBEDS -------------------
function embedExemplo(necessario) {
  const quem = necessario > 1 ? 'todos os jogadores' : 'o jogador';
  return new EmbedBuilder()
    .setColor(COR_AMARELA)
    .setDescription(
      '```diff\n+ PAGAMENTO VIA PIX! 🟢\n```\n' +
        `Assim que **${quem}** tiverem o pagamento confirmado, a sala será criada automaticamente.\n\n` +
        '**Após concluir o PIX, envie no chat uma das mensagens abaixo:**\n' +
        '```\n→ PAGO + NOME E SOBRENOME\n→ PG + NOME E SOBRENOME\n→ PAGUEI + NOME E SOBRENOME\n```\n' +
        '(pode ser o nome completo do Pix, ou o nome + o final do sobrenome)\n\n' +
        '⏳ **Aguarde alguns instantes enquanto o sistema valida sua transferência.**'
    );
}
function embedVerificando(valor) {
  return new EmbedBuilder()
    .setColor(COR_AMARELA)
    .setTitle('🔎 Verificando Pix...')
    .setDescription(`Valor esperado: **${formatarValor(valor)}**`);
}
function embedConfirmado(estado, nome) {
  const falta = estado.necessario - estado.pagos.length;
  return new EmbedBuilder()
    .setColor(COR_VERDE)
    .setTitle('Pix confirmado 🟢')
    .setDescription(
      `**${nome}**\nValor: **${formatarValor(estado.valor)}**\n\n` +
        `⏳ Esperando ${falta === 1 ? 'outro jogador' : `mais ${falta} jogadores`} fazer o pagamento ` +
        `(${estado.pagos.length}/${estado.necessario}).`
    );
}
function embedNaoEncontrado(valor) {
  return new EmbedBuilder()
    .setColor(COR_VERMELHA)
    .setTitle('❌ Pix não encontrado')
    .setDescription(
      `Não achei um Pix de **${formatarValor(valor)}** com esse nome.\n` +
        'Confira o nome e o valor e mande de novo: `pg Nome Sobrenome`.'
    );
}
function embedCriandoSala() {
  return new EmbedBuilder()
    .setColor(COR_AMARELA)
    .setTitle('🛠️ Criando sala...')
    .setDescription('Todos os pagamentos foram confirmados 🟢');
}
// ------------------- LEITURA DO TÓPICO -------------------
function textosDaMensagem(m) {
  const t = [m.content];
  for (const e of m.embeds) {
    t.push(e.title, e.description);
    for (const f of e.fields || []) t.push(`${f.name} ${f.value}`);
  }
  return t.filter(Boolean);
}

// Lê o tópico: valor da fila, nº de jogadores e mediador.
// - Valor: mensagem MAIS RECENTE (de outro bot) com "Valor a ser pago"
//   ou o campo "Valor:" do bot de filas.
// - Jogadores / Mediador: campos "Jogadores:" e "Mediador:" da ficha.
async function descobrirDadosDoTopico(thread, meuId) {
  const msgs = await thread.messages.fetch({ limit: 50 }).catch(() => null);
  let valor = null;
  let jogadores = null;
  let mediadorId = null;
  if (!msgs) return { valor, jogadores, mediadorId };

  for (const m of msgs.values()) {
    if (m.author.id === meuId) continue;
    for (const texto of textosDaMensagem(m)) {
      if (valor === null && /valor/i.test(texto)) {
        const mt = texto.match(/R\$\s*([\d.]+,\d{2}|\d+(?:[.,]\d{1,2})?)/);
        if (mt) valor = parseValor(mt[1]);
      }
    }
    for (const e of m.embeds) {
      for (const f of e.fields || []) {
        if (jogadores === null && /^jogadores/i.test(f.name)) {
          const ids = new Set([...f.value.matchAll(/<@!?(\d+)>/g)].map((x) => x[1]));
          if (ids.size >= 2) jogadores = ids.size;
        }
        if (mediadorId === null && /^mediador/i.test(f.name)) {
          const mt = f.value.match(/<@!?(\d+)>/);
          if (mt) mediadorId = mt[1];
        }
      }
    }
  }
  return { valor, jogadores, mediadorId };
}

// ------------------- FLUXO DO PAGAMENTO -------------------
// API do mediador do tópico (null = não cadastrou)
function apiDoMediador(mediadorId) {
  return (mediadorId && dados.apis[mediadorId]) || null;
}

function estadoDoTopico(id) {
  if (!dados.partidas[id]) {
    dados.partidas[id] = { valor: null, necessario: null, mediadorId: null, pagos: [], statusMsgId: null, exemploMsgId: null, completo: false };
  }
  return dados.partidas[id];
}

// Manda uma mensagem nova e apaga a anterior do bot.
async function enviarStatus(thread, estado, payload) {
  const antiga = estado.statusMsgId;
  const nova = await thread.send(payload).catch(() => null);
  estado.statusMsgId = nova ? nova.id : null;
  await apagar(thread, antiga);
  salvarDados();
  return nova;
}

// Ponto de integração: aqui entra a criação da sala de verdade.
// Hoje só mostra "Criando sala..." e dispara o evento 'salaPix'.
async function aoCompletarPagamentos(thread, estado) {
  client.emit('salaPix', thread, estado);
}

async function processarPagamento(msg, nomeInformado) {
  const thread = msg.channel;
  const estado = estadoDoTopico(thread.id);

  // valor, nº de jogadores e mediador (descobertos no próprio tópico)
  const info = await descobrirDadosDoTopico(thread, client.user.id);
  const api = apiDoMediador(info.mediadorId);
  if (!api) return; // mediador sem API cadastrada: o bot fica em silêncio

  estado.mediadorId = info.mediadorId;
  if (info.valor !== null) estado.valor = info.valor;
  if (info.jogadores !== null) estado.necessario = info.jogadores;
  if (!estado.necessario) estado.necessario = JOGADORES_PADRAO;

  if (estado.completo) {
    const aviso = await thread.send('✅ Os pagamentos desta partida já foram confirmados.').catch(() => null);
    setTimeout(() => aviso && aviso.delete().catch(() => {}), 8000);
    return;
  }
  if (estado.pagos.some((p) => p.userId === msg.author.id)) {
    const aviso = await thread.send(`<@${msg.author.id}> seu Pix já está confirmado 🟢`).catch(() => null);
    setTimeout(() => aviso && aviso.delete().catch(() => {}), 8000);
    return;
  }
  if (normalizar(nomeInformado).length < 2) {
    const aviso = await thread.send(`<@${msg.author.id}> mande o nome e sobrenome do Pix. Ex.: \`pg Daniel Campelo\``).catch(() => null);
    setTimeout(() => aviso && aviso.delete().catch(() => {}), 10000);
    return;
  }
  if (estado.valor === null) {
    await enviarStatus(thread, estado, {
      embeds: [embedNaoEncontrado(0).setDescription('Não consegui descobrir o valor da fila neste tópico. Chame um admin.')],
    });
    return;
  }

  await enviarStatus(thread, estado, { embeds: [embedVerificando(estado.valor)] });

  // Pix pode demorar uns segundos pra aparecer: tenta algumas vezes.
  let achado = null;
  for (let tentativa = 0; tentativa < 4 && !achado; tentativa++) {
    if (tentativa > 0) await esperar(6000);
    let lista;
    try {
      lista = await buscarPagamentosRecentes(api.token, JANELA_MINUTOS);
    } catch (err) {
      console.error('⚠️ Erro ao consultar a API de pagamento:', err.message);
      continue;
    }
    achado = lista.find(
      (p) =>
        !dados.usados.includes(p.id) &&
        Math.abs(p.valor - estado.valor) < 0.005 &&
        p.quando >= thread.createdTimestamp - 60000 &&
        nomeConfere(nomeInformado, p.nome)
    );
  }

  if (!achado) {
    await enviarStatus(thread, estado, { embeds: [embedNaoEncontrado(estado.valor)] });
    return;
  }

  dados.usados.push(achado.id);
  estado.pagos.push({ userId: msg.author.id, nome: tituloNome(achado.nome), paymentId: achado.id, em: Date.now() });
  salvarDados();

  if (estado.pagos.length >= estado.necessario) {
    estado.completo = true;
    await enviarStatus(thread, estado, { embeds: [embedCriandoSala()] });
    await aoCompletarPagamentos(thread, estado);
  } else {
    await enviarStatus(thread, estado, { embeds: [embedConfirmado(estado, tituloNome(achado.nome))] });
  }
}

// ------------------- PAINEL DA API (cada mediador cadastra a sua) -------------------
function podeCadastrar(interaction) {
  if (interaction.user.id === DONO_USER_ID) return true;
  if (interaction.memberPermissions && interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) return true;
  if (!MEDIADOR_ROLE_ID) return true;
  return Boolean(interaction.member && interaction.member.roles && interaction.member.roles.cache.has(MEDIADOR_ROLE_ID));
}

function montarPainelApi() {
  const embed = new EmbedBuilder()
    .setColor(COR_AMARELA)
    .setTitle('🔑 API de pagamento')
    .setDescription(
      'Mediador: cadastre a **sua** API pra o bot confirmar os Pix das suas filas.\n' +
        'Sem API cadastrada, o bot não faz a verificação automática nas suas partidas.'
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('api_cadastrar').setLabel('Cadastrar API').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('api_nova').setLabel('Gerar nova').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('api_excluir').setLabel('Excluir API').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('api_ver').setLabel('Minha API').setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [row] };
}

function montarModalApi(customId, titulo) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(titulo)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('token')
          .setLabel('Access Token (Mercado Pago)')
          .setStyle(TextInputStyle.Short)
          .setMinLength(20)
          .setMaxLength(300)
          .setRequired(true)
      )
    );
}

async function salvarNovaApi(interaction, substituir) {
  const token = interaction.fields.getTextInputValue('token').trim();
  await interaction.deferReply({ ephemeral: true });

  const conta = await validarApiMercadoPago(token).catch(() => null);
  if (!conta) {
    return interaction.editReply('❌ Essa API não é válida (o Mercado Pago recusou). Confira o token e tente de novo.');
  }

  // substituir = a antiga é apagada e a nova entra no lugar
  dados.apis[interaction.user.id] = {
    token,
    provider: 'mercadopago',
    conta: conta.nickname || conta.email || String(conta.id),
    em: Date.now(),
  };
  salvarDados();

  return interaction.editReply(
    substituir ? '✅ API nova salva. A antiga foi excluída do sistema.' : '✅ API cadastrada no sistema. Suas filas agora têm verificação de Pix.'
  );
}

// ------------------- CLIENT -------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const REGEX_PAGO = /^\s*(?:att\s+)?(?:pg|pago|paguei)\b[\s:,-]*(.*)$/is;

function ehTopicoDeFila(canal) {
  return canal && canal.isThread && canal.isThread() && canal.parentId === CANAL_FILAS_ID;
}

client.on('messageCreate', async (msg) => {
  try {
    // painel
    if (!msg.author.bot && msg.content.trim().toLowerCase() === '!painelapi') {
      if (!msg.guild) return;
      const pode =
        msg.author.id === DONO_USER_ID || msg.member?.permissions.has(PermissionsBitField.Flags.ManageGuild);
      if (!pode) return;
      await msg.delete().catch(() => {});
      return msg.channel.send(montarPainelApi());
    }

    if (!ehTopicoDeFila(msg.channel)) return;

    // card de Regras Padrão (de outro bot) -> exemplo de pagamento embaixo
    if (msg.author.bot && msg.author.id !== client.user.id) {
      const ehRegras = msg.embeds.some((e) => REGEX_REGRAS.test(e.title || ''));
      if (ehRegras) {
        await comTrava(msg.channel.id, async () => {
          const estado = estadoDoTopico(msg.channel.id);
          const info = await descobrirDadosDoTopico(msg.channel, client.user.id);
          // só mostra o exemplo se o mediador deste tópico tem API cadastrada
          if (!apiDoMediador(info.mediadorId)) return;
          estado.mediadorId = info.mediadorId;
          if (info.jogadores !== null) estado.necessario = info.jogadores;
          const antigo = estado.exemploMsgId;
          const novo = await msg.channel.send({ embeds: [embedExemplo(estado.necessario || JOGADORES_PADRAO)] }).catch(() => null);
          estado.exemploMsgId = novo ? novo.id : null;
          await apagar(msg.channel, antigo);
          salvarDados();
        });
      }
      return;
    }

    if (msg.author.bot) return;

    // "pg / pago / paguei / att pago" + nome
    const m = msg.content.match(REGEX_PAGO);
    if (!m) return;
    await comTrava(msg.channel.id, () => processarPagamento(msg, m[1].trim()));
  } catch (err) {
    console.error('⚠️ Erro no messageCreate:', err);
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isButton() && interaction.customId.startsWith('api_')) {
      if (!podeCadastrar(interaction)) {
        return interaction.reply({ content: '🚫 Só mediador pode cadastrar API.', ephemeral: true });
      }
      const minha = dados.apis[interaction.user.id];

      if (interaction.customId === 'api_cadastrar') {
        if (minha) {
          return interaction.reply({ content: 'Você já tem uma API cadastrada. Use **Gerar nova** pra trocar ou **Excluir API**.', ephemeral: true });
        }
        return interaction.showModal(montarModalApi('modal_api_cadastrar', 'Cadastrar API'));
      }
      if (interaction.customId === 'api_nova') {
        return interaction.showModal(montarModalApi('modal_api_nova', 'Gerar nova API'));
      }
      if (interaction.customId === 'api_ver') {
        return interaction.reply({
          content: minha ? `🟢 API cadastrada (conta **${minha.conta}**, final **${minha.token.slice(-4)}**).` : '🔴 Você não tem API cadastrada.',
          ephemeral: true,
        });
      }
      if (interaction.customId === 'api_excluir') {
        if (!minha) return interaction.reply({ content: 'Você não tem API cadastrada.', ephemeral: true });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('api_excluir_confirmar').setLabel('Confirmar exclusão').setStyle(ButtonStyle.Danger)
        );
        return interaction.reply({ content: 'Excluir a sua API do sistema? O bot para de confirmar Pix nas suas filas.', components: [row], ephemeral: true });
      }
      if (interaction.customId === 'api_excluir_confirmar') {
        delete dados.apis[interaction.user.id];
        salvarDados();
        return interaction.update({ content: '🗑️ API excluída do sistema.', components: [] });
      }
    }

    if (interaction.isModalSubmit()) {
      if (!podeCadastrar(interaction)) {
        return interaction.reply({ content: '🚫 Só mediador pode cadastrar API.', ephemeral: true });
      }
      if (interaction.customId === 'modal_api_cadastrar') return salvarNovaApi(interaction, false);
      if (interaction.customId === 'modal_api_nova') return salvarNovaApi(interaction, true);
    }
  } catch (err) {
    console.error('⚠️ Erro numa interação:', err);
    const aviso = { content: '⚠️ Deu um erro inesperado. Tenta de novo.', ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(aviso).catch(() => {});
    else await interaction.reply(aviso).catch(() => {});
  }
});

// Limpa o estado de tópicos apagados
client.on('threadDelete', (thread) => {
  if (dados.partidas[thread.id]) {
    delete dados.partidas[thread.id];
    salvarDados();
  }
});

client.once('ready', () => console.log(`✅ Pix Bot online como ${client.user.tag}`));

process.on('unhandledRejection', (err) => console.error('⚠️ unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('⚠️ uncaughtException:', err));

client.login(TOKEN);
