import { CHEATS, PokerGame, SUITS, RANKS, cardLabel, evaluateHand } from "./game.js";
import { MultiplayerClient } from "./multiplayer.js";

const $ = (selector) => document.querySelector(selector);
const elements = {
  lobby: $("#lobby"),
  game: $("#game"),
  resultScreen: $("#result-screen"),
  actionDialog: $("#action-dialog"),
  dialogForm: $("#dialog-form"),
  dialogContent: $("#dialog-content"),
  notice: $("#notice"),
  cheatAlert: $("#cheat-alert"),
  cpuCards: $("#cpu-cards"),
  humanCards: $("#human-cards"),
  communityCards: $("#community-cards"),
  gameLog: $("#game-log"),
  cheatButtons: $("#cheat-buttons"),
};

let game;
let cpuTimer = null;
let selectedDrawCards = new Set();
let temporaryPeek = new Set();
let peekTimeout = null;
let opponentTellTimeout = null;
let opponentTell = false;
let localHint = "";
let cpuPeekedHand = null;
let onlineClient = null;
let onlineSession = null;
let localPlayerIndex = 0;
let busy = false;

$("#start-button").addEventListener("click", () => startGame());
$("#cpu-mode-button").addEventListener("click", () => setLobbyMode("cpu"));
$("#online-mode-button").addEventListener("click", () => setLobbyMode("online"));
$("#create-room-button").addEventListener("click", () => createOrJoinRoom("create"));
$("#join-room-button").addEventListener("click", () => createOrJoinRoom("join"));
$("#start-match-button").addEventListener("click", () => sendOnline("start"));
$("#leave-room-button").addEventListener("click", exitOnlineRoom);
$("#hand-rankings-button").addEventListener("click", () => $("#hand-rankings-dialog").showModal());
$("#copy-room-code-button").addEventListener("click", async () => {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("この環境ではコピーできません。ルームコードを選択してコピーしてください。");
    await navigator.clipboard.writeText($("#waiting-room-code").textContent);
    $("#waiting-status").textContent = "ルームコードをコピーしました。";
    $("#waiting-status").classList.remove("error");
  } catch (error) {
    $("#waiting-status").textContent = error.message;
    $("#waiting-status").classList.add("error");
  }
});
$("#new-game-button").addEventListener("click", () => {
  if (!window.confirm(onlineClient ? "ルームを退出しますか？" : "現在の対戦を終了して、最初からやり直しますか？")) return;
  if (onlineClient) exitOnlineRoom();
  else startGame();
});
$("#restart-button").addEventListener("click", () => onlineClient ? sendOnline("restart") : startGame());
$("#result-restart-button").addEventListener("click", () => onlineClient ? sendOnline("restart") : startGame());
$("#result-leave-button").addEventListener("click", exitOnlineRoom);
$("#next-round-button").addEventListener("click", () => {
  if (!game || game.matchOver || busy) return;
  clearOpponentTell();
  selectedDrawCards.clear();
  clearTemporaryPeek();
  localHint = "";
  cpuPeekedHand = null;
  if (onlineClient) sendOnline("next");
  else {
    game.startHand();
    render();
    scheduleCpu();
  }
});
$("#check-button").addEventListener("click", () => runHumanAction("check"));
$("#call-button").addEventListener("click", () => runHumanAction("call"));
$("#fold-button").addEventListener("click", () => runHumanAction("fold"));
$("#raise-button").addEventListener("click", () => runHumanAction("raise", Number($("#raise-amount").value)));
$("#draw-button").addEventListener("click", () => {
  if (!game || game.phase !== "draw" || !isHumanDrawTurn() || busy) return;
  try {
    const selected = [...selectedDrawCards].sort((a, b) => a - b);
    selectedDrawCards.clear();
    localHint = "";
    if (onlineClient) sendOnline("exchange", { handIndices: selected });
    else {
      game.exchange(0, selected);
      render();
      scheduleCpu();
    }
  } catch (error) {
    showError(error);
  }
});
$("#doubt-button").addEventListener("click", openDoubtDialog);
elements.cheatButtons.addEventListener("click", (event) => {
  const button = event.target.closest("[data-cheat]");
  if (button && !button.disabled) openCheatDialog(button.dataset.cheat);
});
elements.humanCards.addEventListener("click", (event) => {
  const card = event.target.closest("[data-card-index]");
  if (!card || !isHumanDrawTurn()) return;
  const index = Number(card.dataset.cardIndex);
  if (selectedDrawCards.has(index)) selectedDrawCards.delete(index);
  else selectedDrawCards.add(index);
  render();
});
elements.dialogForm.addEventListener("submit", (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
});

const temporaryPeekCards = new Map();

function setLobbyMode(mode) {
  const online = mode === "online";
  $("#cpu-setup").classList.toggle("hidden", online);
  $("#online-setup").classList.toggle("hidden", !online);
  $("#cpu-mode-button").classList.toggle("active", !online);
  $("#online-mode-button").classList.toggle("active", online);
  $("#cpu-mode-button").setAttribute("aria-pressed", String(!online));
  $("#online-mode-button").setAttribute("aria-pressed", String(online));
}

function setRoomStatus(message, isError = false) {
  const status = $("#room-status");
  status.textContent = message;
  status.classList.toggle("hidden", !message);
  status.classList.toggle("error", isError);
}

function createOnlineClient() {
  onlineClient = new MultiplayerClient({
    onState: (state) => {
      const previousHandNumber = game?.handNumber;
      onlineSession = state;
      localPlayerIndex = state.playerIndex;
      game = state.game;
      $("#cpu-mode-button").disabled = true;
      $("#online-mode-button").disabled = true;
      $("#leave-room-button").classList.remove("hidden");
      if (previousHandNumber && game?.handNumber !== previousHandNumber) {
        clearTemporaryPeek();
        clearOpponentTell();
      }
      $("#waiting-room-code").textContent = state.roomCode;
      $("#start-match-button").classList.toggle("hidden", !state.isHost || Boolean(state.game));
      $("#start-match-button").disabled = state.connected.some((connected) => !connected);
      if (state.game) {
        $("#lobby").classList.add("hidden");
        $("#room-waiting").classList.add("hidden");
        $("#game").classList.remove("hidden");
      } else {
        $("#lobby").classList.add("hidden");
        $("#room-waiting").classList.remove("hidden");
        renderWaitingRoom(state);
      }
      if (game) {
        render();
      }
    },
    onOpponentTell: showOpponentTell,
    onDisconnect: (message) => {
      if (onlineSession && !onlineSession.game) {
        $("#waiting-status").textContent = message;
        $("#waiting-status").classList.add("error");
      } else {
        localHint = message;
        render();
      }
    },
  });
}

function renderWaitingRoom(state) {
  const selfIndex = state.playerIndex;
  const opponentIndex = 1 - selfIndex;
  const opponentConnected = state.connected[opponentIndex];
  $("#waiting-self-role").textContent = selfIndex === 0 ? "HOST · あなた" : "GUEST · あなた";
  $("#waiting-self-name").textContent = state.playerNames[selfIndex] ?? "あなた";
  $("#waiting-self-status").textContent = state.connected[selfIndex] ? "接続中" : "再接続待ち";
  $("#waiting-opponent-role").textContent = selfIndex === 0 ? "GUEST · 対戦相手" : "HOST · 対戦相手";
  $("#waiting-opponent-name").textContent = state.playerNames[opponentIndex] ?? "対戦相手";
  $("#waiting-opponent-status").textContent = opponentConnected ? "参加しました" : "参加待ち";
  $("#waiting-player-opponent").classList.toggle("waiting-player-empty", !opponentConnected);
  $("#waiting-mode").textContent = state.mode === "holdem" ? "テキサスホールデム" : "5カードドロー";
  $("#waiting-title").textContent = opponentConnected ? "対戦の準備ができました" : "対戦相手を待っています";
  $("#waiting-description").textContent = opponentConnected
    ? (state.isHost ? "参加者がそろいました。対戦を開始できます。" : "ホストが対戦を開始するまでお待ちください。")
    : "ルームコードを友達に共有してください。参加すると対戦を始められます。";
  $("#waiting-status").textContent = opponentConnected ? "両プレイヤーが接続しています。" : "相手の参加を待っています…";
  $("#waiting-status").classList.remove("error");
}

async function createOrJoinRoom(action) {
  if (onlineClient || busy) return;
  createOnlineClient();
  busy = true;
  $("#cpu-mode-button").disabled = true;
  $("#online-mode-button").disabled = true;
  setRoomStatus("サーバーに接続しています…");
  try {
    const name = $("#player-name").value;
    const fields = action === "create"
      ? { name, mode: $("#online-mode").value }
      : { name, roomCode: $("#join-room-code").value };
    await onlineClient.request(action, fields);
  } catch (error) {
    onlineClient?.close();
    onlineClient = null;
    $("#cpu-mode-button").disabled = false;
    $("#online-mode-button").disabled = false;
    setRoomStatus(error.message, true);
  } finally {
    busy = false;
  }
}

async function sendOnline(type, fields = {}) {
  if (!onlineClient || busy) return;
  busy = true;
  localHint = "";
  render();
  try {
    const result = await onlineClient.request(type, fields);
    if (type === "cheat") {
      const { cheatId } = fields;
      if (cheatId === "peek") {
        temporaryPeekCards.clear();
        result.forEach(({ index, card }) => temporaryPeekCards.set(index, card));
        temporaryPeek = new Set(result.map(({ index }) => index));
        localHint = `透視：選んだカードは ${result.map(({ card }) => cardLabel(card)).join("　")}`;
        if (peekTimeout) window.clearTimeout(peekTimeout);
        peekTimeout = window.setTimeout(() => {
          clearTemporaryPeek();
          localHint = "";
          render();
        }, 5000);
      } else if (cheatId === "deck") {
        localHint = `引いたカード：${cardLabel(result.card)}`;
      } else if (cheatId === "sleeve") {
        localHint = result.action === "隠す" ? "カードを袖に隠しました。" : "袖のカードと手札を交換しました。";
      } else {
        localHint = `書き換えました：${cardLabel(result.card)}`;
      }
    } else if (type === "challenge") {
      localHint = result.success ? "ダウト成功！" : `ダウト失敗。${result.penalty}チップを支払いました。`;
    }
  } catch (error) {
    localHint = error.message;
  } finally {
    busy = false;
    render();
  }
}

function exitOnlineRoom() {
  onlineClient?.close();
  clearTemporaryPeek();
  onlineClient = null;
  onlineSession = null;
  game = null;
  localPlayerIndex = 0;
  busy = false;
  localHint = "";
  $("#room-waiting").classList.add("hidden");
  $("#game").classList.add("hidden");
  elements.resultScreen.classList.add("hidden");
  $("#lobby").classList.remove("hidden");
  $("#start-match-button").classList.add("hidden");
  $("#leave-room-button").classList.add("hidden");
  $("#cpu-mode-button").disabled = false;
  $("#online-mode-button").disabled = false;
  setRoomStatus("");
  setLobbyMode("online");
}

function clearTemporaryPeek() {
  if (peekTimeout) window.clearTimeout(peekTimeout);
  peekTimeout = null;
  temporaryPeek.clear();
  temporaryPeekCards.clear();
}

function startGame() {
  if (onlineClient) return;
  if (cpuTimer) window.clearTimeout(cpuTimer);
  cpuTimer = null;
  clearTemporaryPeek();
  clearOpponentTell();
  const mode = document.querySelector('input[name="mode"]:checked').value;
  game = new PokerGame({ mode }).startHand();
  localPlayerIndex = 0;
  selectedDrawCards.clear();
  temporaryPeek.clear();
  temporaryPeekCards.clear();
  localHint = "";
  cpuPeekedHand = null;
  elements.lobby.classList.add("hidden");
  elements.resultScreen.classList.add("hidden");
  elements.game.classList.remove("hidden");
  render();
  scheduleCpu();
}

function isHumanDrawTurn() {
  return game?.phase === "draw" && game.drawOrder[game.drawTurn] === localPlayerIndex;
}

function runHumanAction(action, amount) {
  if (!game || game.phase !== "bet" || game.turn !== localPlayerIndex || busy) return;
  try {
    if (onlineClient) sendOnline("action", { action, amount });
    else {
      game.act(0, action, amount);
      localHint = "";
      render();
      scheduleCpu();
    }
  } catch (error) {
    showError(error);
  }
}

function scheduleCpu() {
  if (!game || game.phase === "gameover" || game.phase === "settled" || cpuTimer) return;
  const cpuTurn = (game.phase === "bet" && game.turn === 1) || (game.phase === "draw" && game.drawOrder[game.drawTurn] === 1);
  if (!cpuTurn) return;
  $("#cpu-status").textContent = "対戦中";
  $("#turn-label").textContent = "CPUの番です";
  cpuTimer = window.setTimeout(() => {
    cpuTimer = null;
    if (!game || game.phase === "gameover" || game.phase === "settled") return;
    if (elements.actionDialog.open) {
      scheduleCpu();
      return;
    }
    cpuAct();
    render();
    scheduleCpu();
  }, 650);
}

function cpuAct() {
  if (game.cheatUsed[0].length && Math.random() < 0.2) {
    const knownCheats = [...new Set(game.cheatUsed[0])];
    const guess = Math.random() < 0.8 ? knownCheats[Math.floor(Math.random() * knownCheats.length)] : randomCheat();
    const result = game.challenge(1, guess);
    if (result.success) return;
  }

  if (Math.random() < 0.24 && cpuCheat()) showOpponentTell();
  if (game.phase === "draw" && game.drawOrder[game.drawTurn] === 1) {
    const cards = game.players[1].hand;
    const keep = new Set();
    const ranks = new Map();
    cards.forEach((card, index) => {
      const indices = ranks.get(card.rank) ?? [];
      indices.push(index);
      ranks.set(card.rank, indices);
    });
    for (const indices of ranks.values()) if (indices.length > 1) indices.forEach((index) => keep.add(index));
    const exchange = cards.flatMap((card, index) => (
      card.rank < 10 && !keep.has(index) ? [index] : []
    ));
    game.exchange(1, exchange.slice(0, 3));
    return;
  }

  if (game.phase !== "bet" || game.turn !== 1) return;
  const options = game.getCallOptions(1);
  const strength = cpuHandStrength();
  if ((options.callAmount > 35 && strength < 2 && Math.random() < 0.68)
    || (options.callAmount > 10 && strength < 4 && cpuOpponentLooksStrong())) {
    game.act(1, "fold");
  } else if (options.callAmount === 0) {
    if (options.canRaise && strength >= 5 && Math.random() < 0.2) game.act(1, "raise", 20);
    else game.act(1, "check");
  } else if (options.canRaise && strength >= 6 && Math.random() < 0.16) {
    game.act(1, "raise", Math.min(20, options.maxRaise));
  } else {
    game.act(1, "call");
  }
}

function cpuCheat() {
  const player = game.players[1];
  const choices = CHEATS.filter(({ cost = 0, id, maxUses }) => (
    cost <= player.mp && (id !== "rewrite" || player.rewriteUses < maxUses)
  ));
  if (choices.length === 0) return false;
  const selected = choices[Math.floor(Math.random() * choices.length)].id;
  if (selected === "peek") {
    const indices = player.hand
      .map((card, index) => ({ card, index }))
      .sort((left, right) => right.card.rank - left.card.rank)
      .slice(0, Math.min(3, player.hand.length))
      .map(({ index }) => index);
    cpuPeekedHand = game.useCheat(1, selected, { handIndices: indices });
  } else if (selected === "deck") {
    game.useCheat(1, selected, { handIndex: weakestCardIndex(player.hand), side: "top" });
  } else if (selected === "rewrite") {
    const index = weakestCardIndex(player.hand);
    game.useCheat(1, selected, { handIndex: index, suit: player.hand[0].suit, rank: Math.min(14, player.hand[index].rank + 3) });
  } else {
    game.useCheat(1, selected, { handIndex: weakestCardIndex(player.hand) });
  }
  return true;
}

function showOpponentTell() {
  if (opponentTellTimeout) window.clearTimeout(opponentTellTimeout);
  opponentTell = true;
  render();
  opponentTellTimeout = window.setTimeout(() => {
    opponentTell = false;
    opponentTellTimeout = null;
    render();
  }, 4500);
}

function clearOpponentTell() {
  if (opponentTellTimeout) window.clearTimeout(opponentTellTimeout);
  opponentTellTimeout = null;
  opponentTell = false;
}

function cpuOpponentLooksStrong() {
  if (!cpuPeekedHand) return false;
  const humanHand = game.players[0].hand;
  if (game.mode === "holdem" && game.community.length < 3) {
    return humanHand[0].rank === humanHand[1].rank
      || (Math.min(...humanHand.map(({ rank }) => rank)) >= 12);
  }
  const cards = game.mode === "holdem" ? [...humanHand, ...game.community] : humanHand;
  return evaluateHand(cards).score[0] >= 2;
}

function weakestCardIndex(cards) {
  return cards.reduce((weakest, card, index) => card.rank < cards[weakest].rank ? index : weakest, 0);
}

function cpuHandStrength() {
  const player = game.players[1];
  if (game.mode === "draw" || game.community.length >= 3) {
    const cards = game.mode === "draw" ? player.hand : [...player.hand, ...game.community];
    return evaluateHand(cards).score[0];
  }
  const [first, second] = player.hand;
  if (first.rank === second.rank) return first.rank >= 11 ? 3 : 2;
  if (Math.max(first.rank, second.rank) >= 13 && Math.min(first.rank, second.rank) >= 10) return 2;
  return 0;
}

function randomCheat() {
  return CHEATS[Math.floor(Math.random() * CHEATS.length)].id;
}

function render() {
  if (!game) return;
  const opponentIndex = 1 - localPlayerIndex;
  const human = game.players[localPlayerIndex];
  const opponent = game.players[opponentIndex];
  const matchOver = game.matchOver;
  const localWinner = human.stack > opponent.stack;
  const opponentWinner = opponent.stack > human.stack;
  elements.game.classList.toggle("hidden", matchOver);
  elements.resultScreen.classList.toggle("hidden", !matchOver);
  if (matchOver) {
    $("#result-title").textContent = localWinner ? "勝利" : opponentWinner ? "敗北" : "引き分け";
    $("#result-message").textContent = game.notice;
    $("#result-human-name").textContent = onlineClient ? human.name : "あなた";
    $("#result-opponent-name").textContent = onlineClient ? opponent.name : "CPU";
    $("#result-human-stack").textContent = String(human.stack);
    $("#result-opponent-stack").textContent = String(opponent.stack);
    $("#result-human").classList.toggle("is-winner", localWinner);
    $("#result-opponent").classList.toggle("is-winner", opponentWinner);
    $("#result-restart-button").disabled = busy || Boolean(onlineClient && !onlineSession?.isHost);
    $("#result-restart-button").textContent = onlineClient ? "もう一度対戦する →" : "もう一度遊ぶ →";
    $("#result-waiting").classList.toggle("hidden", !onlineClient || Boolean(onlineSession?.isHost));
    $("#result-waiting").textContent = "ホストが新しいゲームを開始するまでお待ちください。";
    $("#result-leave-button").classList.toggle("hidden", !onlineClient);
  }
  $("#human-name").textContent = onlineClient ? human.name : "あなた";
  $("#opponent-name").textContent = onlineClient ? opponent.name : "CPU";
  $("#human-avatar").textContent = onlineClient ? human.name.slice(0, 3) : "YOU";
  $("#opponent-avatar").textContent = onlineClient ? opponent.name.slice(0, 3) : "CPU";
  $("#new-game-button").textContent = onlineClient ? "ルームを退出" : "ゲームをやり直す";
  $("#round-number").textContent = String(game.handNumber);
  $("#mode-name").textContent = game.mode === "draw" ? "5カードドロー" : "テキサスホールデム";
  $("#street-name").textContent = game.street;
  $("#cpu-stack").textContent = String(opponent.stack);
  $("#human-stack").textContent = String(human.stack);
  $("#pot").textContent = String(game.pot);
  $("#human-mp").textContent = String(human.mp);
  $("#mp-fill").style.width = `${human.mp * 20}%`;
  $("#sleeve-status").classList.toggle("hidden", !human.sleeve);
  $("#cpu-status").textContent = game.phase === "settled" || game.phase === "gameover" ? "ラウンド終了" : onlineClient && !onlineSession?.connected[opponentIndex] ? "再接続待ち" : "対戦中";
  $("#human-status").textContent = game.phase === "settled" || game.phase === "gameover" ? "ラウンド終了" : isHumanTurn() ? "あなたの番" : "対戦中";

  renderCards(elements.cpuCards, opponent.hand, !game.revealed, false, temporaryPeek, temporaryPeekCards);
  renderCards(elements.humanCards, human.hand, false, isHumanDrawTurn());
  renderCards(elements.communityCards, game.community, false, false);
  renderActions();
  renderLogs();
  renderNotice();
  elements.cheatAlert.classList.toggle("hidden", !opponentTell);

  const message = game.phase === "gameover"
    ? "ゲーム終了"
    : game.phase === "settled"
      ? "ラウンド終了"
      : game.phase === "draw"
        ? (isHumanDrawTurn() ? "交換するカードを選んでください" : `${onlineClient ? "相手" : "CPU"}の交換を待っています`)
        : game.phase === "bet"
          ? (game.turn === localPlayerIndex ? "あなたの番です" : `${onlineClient ? "相手" : "CPU"}の番です`)
          : "対戦を開始してください";
  $("#table-message").textContent = localHint || game.notice || message;
}

function isHumanTurn() {
  return (game.phase === "bet" && game.turn === localPlayerIndex) || isHumanDrawTurn();
}

function renderCards(container, cards, faceDown, selectable, revealedIndices = new Set(), revealedCards = new Map()) {
  container.replaceChildren(...cards.map((card, index) => {
    const shownCard = faceDown && revealedIndices.has(index) ? (revealedCards.get(index) ?? card) : card;
    const element = document.createElement("div");
    const concealed = faceDown && !revealedIndices.has(index);
    element.className = `playing-card${concealed ? " card-back" : ""}${!concealed && ["♥", "♦"].includes(shownCard.suit) ? " red" : ""}${selectable && selectedDrawCards.has(index) ? " selected" : ""}`;
    element.setAttribute("aria-label", concealed ? "伏せたカード" : cardLabel(shownCard));
    if (!concealed) {
      const rank = document.createElement("span");
      rank.className = "rank";
      rank.textContent = cardLabel(shownCard).slice(0, -1);
      const suit = document.createElement("span");
      suit.className = "suit";
      suit.textContent = shownCard.suit;
      element.append(rank, suit);
    }
    if (container === elements.humanCards) element.dataset.cardIndex = String(index);
    return element;
  }));
}

function renderActions() {
  const betting = game.phase === "bet" && game.turn === localPlayerIndex;
  const draw = isHumanDrawTurn();
  const settled = game.phase === "settled";
  const over = game.phase === "gameover";
  const localPlayer = game.players[localPlayerIndex];
  const options = onlineClient ? game.callOptions : game.getCallOptions(localPlayerIndex);
  $("#bet-actions").classList.toggle("hidden", game.phase !== "bet");
  $("#draw-actions").classList.toggle("hidden", !draw);
  $("#round-actions").classList.toggle("hidden", !settled && !over);
  $("#next-round-button").classList.toggle("hidden", !settled || over);
  $("#next-round-button").disabled = busy || Boolean(onlineClient && !onlineSession?.isHost);
  $("#restart-button").classList.toggle("hidden", !over);
  $("#restart-button").disabled = busy || Boolean(onlineClient && !onlineSession?.isHost);
  $("#check-button").disabled = busy || !betting || !options.canCheck;
  $("#call-button").disabled = busy || !betting || !options.canCall;
  $("#call-amount").textContent = options.canCall ? `(${options.callAmount})` : "";
  $("#raise-button").disabled = busy || !betting || !options.canRaise;
  $("#raise-amount").min = "10";
  $("#raise-amount").max = String(options.maxRaise);
  $("#raise-amount").value = String(Math.min(Math.max(20, options.minRaise), Math.max(options.minRaise, options.maxRaise)));
  $("#fold-button").disabled = busy || !betting;
  $("#draw-button").textContent = `選んだカードを交換（${selectedDrawCards.size}枚）`;
  $("#turn-label").textContent = betting ? "あなたのアクションを選択" : "";
  $("#doubt-button").disabled = busy || !["bet", "draw"].includes(game.phase) || localPlayer.lockedOut;
  $("#doubt-button").title = localPlayer.lockedOut ? "このラウンドではダウトできません" : "ラウンド中いつでも相手を指摘";

  elements.cheatButtons.replaceChildren(...CHEATS.map((cheat) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cheat-button";
    button.dataset.cheat = cheat.id;
    const rewriteLimitReached = cheat.id === "rewrite" && localPlayer.rewriteUses >= cheat.maxUses;
    const lacksMp = cheat.cost !== undefined && localPlayer.mp < cheat.cost;
    button.disabled = busy || !["bet", "draw"].includes(game.phase) || lacksMp || rewriteLimitReached;
    const title = document.createElement("strong");
    title.textContent = cheat.label;
    const cost = document.createElement("span");
    cost.textContent = cheat.maxUses !== undefined
      ? `残り${Math.max(0, cheat.maxUses - localPlayer.rewriteUses)}回`
      : `${cheat.cost} MP`;
    button.append(title, cost);
    return button;
  }));
}

function renderLogs() {
  elements.gameLog.replaceChildren(...[...game.logs].reverse().map((line) => {
    const item = document.createElement("li");
    item.textContent = line;
    return item;
  }));
}

function renderNotice() {
  const show = Boolean(game.notice) || Boolean(localHint);
  elements.notice.classList.toggle("hidden", !show);
  elements.notice.textContent = localHint || game.notice;
}

function showError(error) {
  localHint = error instanceof Error ? error.message : "処理に失敗しました。";
  render();
}

function openDoubtDialog() {
  if (!game || game.players[localPlayerIndex].lockedOut || !["bet", "draw"].includes(game.phase)) return;
  showDialog({
    title: "ダウト（指摘）",
    description: "相手がこのラウンドに使ったと思うイカサマを選んでください。成功すればラウンド勝利。失敗するとチップを失い、このラウンドは再指摘できません。",
    fields: [{ name: "cheatId", label: "指摘するイカサマ", options: CHEATS.map(({ id, label }) => [id, label]) }],
    confirm: "指摘する",
    onConfirm: (data) => {
      if (onlineClient) sendOnline("challenge", { cheatId: data.cheatId });
      else {
        const result = game.challenge(localPlayerIndex, data.cheatId);
        localHint = "";
        if (result.success) {
          if (cpuTimer) window.clearTimeout(cpuTimer);
          cpuTimer = null;
        }
        render();
      }
    },
  });
}

function openCheatDialog(cheatId) {
  const cheat = CHEATS.find(({ id }) => id === cheatId);
  const player = game?.players[localPlayerIndex];
  const opponent = game?.players[1 - localPlayerIndex];
  if (!game || !cheat || (cheat.cost !== undefined && player.mp < cheat.cost)
    || (cheat.id === "rewrite" && player.rewriteUses >= cheat.maxUses)) return;
  const handFields = [{ name: "handIndex", label: "対象の手札", options: player.hand.map((card, index) => [String(index), `カード ${index + 1}${card ? `（${cardLabel(card)}）` : ""}`]) }];
  let fields = [];
  let description = cheat.description;

  if (cheatId === "deck") {
    fields = [
      { name: "side", label: "引く位置", options: [["top", "山札の上"], ["bottom", "山札の下"]] },
      ...handFields,
    ];
    description = "山札の上または下から1枚引き、選んだ手札と入れ替えます。";
  } else if (cheatId === "sleeve") {
    fields = handFields;
    description = player.sleeve
      ? "隠しておいたカードを選んだ手札と交換します。使用には2MPかかります。"
      : "選んだカードを隠し、山札から1枚引いて手札に補充します。後で交換できます。";
  } else if (cheatId === "rewrite") {
    fields = [
      ...handFields,
      { name: "rank", label: "書き換える数字", options: RANKS.map((rank) => [String(rank), rank <= 10 ? String(rank) : ({ 11: "J", 12: "Q", 13: "K", 14: "A" })[rank]]) },
      { name: "suit", label: "書き換えるスート", options: SUITS.map((suit) => [suit, suit]) },
    ];
    description = "手札の1枚を指定した数字とスートに書き換えます。";
  } else {
    const count = Math.min(3, opponent.hand.length);
    fields = [{
      name: "handIndices",
      label: `確認するカードを${count}枚選択`,
      type: "checkboxes",
      options: opponent.hand.map((_, index) => [String(index), `相手の手札 ${index + 1}枚目`]),
    }];
    description = `相手の手札から${count}枚を選んで確認します。この行動はゲームログに残りません。`;
  }

  showDialog({
    title: cheat.cost === undefined
      ? `${cheat.label} · 残り${cheat.maxUses - player.rewriteUses}回`
      : `${cheat.label} · ${cheat.cost} MP`,
    description,
    fields,
    confirm: cheatId === "peek" ? "透視する" : cheatId === "sleeve" && player.sleeve ? "交換する" : "発動する",
    onConfirm: (data) => {
      const options = {
        ...data,
        handIndices: data.handIndices?.map(Number),
        handIndex: data.handIndex === undefined ? undefined : Number(data.handIndex),
        rank: data.rank === undefined ? undefined : Number(data.rank),
      };
      if (onlineClient) {
        sendOnline("cheat", { cheatId, options });
        return;
      }
      const result = game.useCheat(localPlayerIndex, cheatId, options);
      if (cheatId === "peek") {
        temporaryPeek = new Set(result.map(({ index }) => index));
        localHint = `透視：選んだカードは ${result.map(({ card }) => cardLabel(card)).join("　")} `;
        if (peekTimeout) window.clearTimeout(peekTimeout);
        peekTimeout = window.setTimeout(() => {
          temporaryPeek.clear();
          localHint = "";
          peekTimeout = null;
          render();
        }, 5000);
      } else if (cheatId === "deck") {
        localHint = `引いたカード：${cardLabel(result.card)}`;
      } else if (cheatId === "sleeve") {
        localHint = result.action === "隠す" ? "カードを袖に隠しました。" : "袖のカードと手札を交換しました。";
      } else {
        localHint = `書き換えました：${cardLabel(result.card)}`;
      }
      render();
    },
  });
}

function showDialog({ title, description, fields, confirm, onConfirm }) {
  elements.dialogContent.replaceChildren();
  const heading = document.createElement("h2");
  heading.className = "dialog-title";
  heading.textContent = title;
  const copy = document.createElement("p");
  copy.className = "dialog-copy";
  copy.textContent = description;
  elements.dialogContent.append(heading, copy);
  fields.forEach((field) => {
    const label = document.createElement(field.type === "checkboxes" ? "div" : "label");
    label.className = "form-field";
    const caption = document.createElement("span");
    caption.textContent = field.label;
    if (field.type === "checkboxes") {
      const options = document.createElement("div");
      options.className = "checkbox-options";
      field.options.forEach(([value, text]) => {
        const optionLabel = document.createElement("label");
        optionLabel.className = "checkbox-option";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.name = field.name;
        checkbox.value = value;
        const optionText = document.createElement("span");
        optionText.textContent = text;
        optionLabel.append(checkbox, optionText);
        options.append(optionLabel);
      });
      label.append(caption, options);
      elements.dialogContent.append(label);
      return;
    }
    const select = document.createElement("select");
    select.name = field.name;
    field.options.forEach(([value, text]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      select.append(option);
    });
    label.append(caption, select);
    elements.dialogContent.append(label);
  });
  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  const cancel = document.createElement("button");
  cancel.className = "button button-secondary";
  cancel.value = "cancel";
  cancel.textContent = "キャンセル";
  const submit = document.createElement("button");
  submit.className = "button button-primary";
  submit.type = "button";
  submit.textContent = confirm;
  submit.addEventListener("click", () => {
    const formData = new FormData(elements.dialogForm);
    const data = Object.fromEntries([...new Set(formData.keys())].map((key) => {
      const values = formData.getAll(key);
      return [key, values.length > 1 ? values : values[0]];
    }));
    fields.filter((field) => field.type === "checkboxes").forEach((field) => {
      data[field.name] = formData.getAll(field.name);
    });
    try {
      onConfirm(data);
      elements.actionDialog.close();
    } catch (error) {
      localHint = error instanceof Error ? error.message : "処理に失敗しました。";
      render();
      elements.actionDialog.close();
    }
  });
  actions.append(cancel, submit);
  elements.dialogContent.append(actions);
  elements.actionDialog.showModal();
}

const savedOnlineSession = sessionStorage.getItem("pokerOnlineSession");
if (savedOnlineSession) {
  try {
    const saved = JSON.parse(savedOnlineSession);
    setLobbyMode("online");
    $("#player-name").value = saved.name;
    $("#join-room-code").value = saved.roomCode;
    createOnlineClient();
    onlineClient.request("resume", { token: saved.token }).catch((error) => {
      onlineClient?.close();
      onlineClient = null;
      setRoomStatus(error.message, true);
    });
  } catch (error) {
    sessionStorage.removeItem("pokerOnlineSession");
    setRoomStatus("保存された再接続情報を読み取れませんでした。", true);
  }
}
