export const SUITS = ["♠", "♥", "♦", "♣"];
export const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
export const CHEATS = [
  { id: "peek", label: "透視", cost: 3, description: "相手の手札から選んだ3枚を見る" },
  { id: "deck", label: "山札操作", cost: 2, description: "山札から1枚引いて交換" },
  { id: "sleeve", label: "袖の下", cost: 2, description: "カードを隠して後で交換" },
  { id: "discard", label: "捨て札取り", cost: 2, description: "捨て札から1枚を取り出して手札に加える" },
  { id: "rewrite", label: "書き換え", maxUses: 2, description: "MPを消費せず、対戦中各プレイヤー2回までカードの数字・スートを変更" },
];

const rankNames = {
  2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9",
  10: "10", 11: "J", 12: "Q", 13: "K", 14: "A",
};

export function cardLabel(card) {
  return `${rankNames[card.rank]}${card.suit}`;
}

function shuffledDeck(random = Math.random) {
  const deck = SUITS.flatMap((suit) => RANKS.map((rank) => ({ suit, rank })));
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function combinations(cards, size = 5) {
  const result = [];
  function visit(start, chosen) {
    if (chosen.length === size) {
      result.push(chosen);
      return;
    }
    for (let i = start; i <= cards.length - (size - chosen.length); i += 1) {
      visit(i + 1, [...chosen, cards[i]]);
    }
  }
  visit(0, []);
  return result;
}

function straightHigh(ranks) {
  const unique = [...new Set(ranks)].sort((a, b) => b - a);
  if (unique[0] === 14) unique.push(1);
  for (let i = 0; i <= unique.length - 5; i += 1) {
    if (unique[i] - unique[i + 4] === 4) return unique[i];
  }
  return 0;
}

function evaluateFive(cards) {
  const ranks = cards.map(({ rank }) => rank).sort((a, b) => b - a);
  const counts = new Map();
  ranks.forEach((rank) => counts.set(rank, (counts.get(rank) ?? 0) + 1));
  const groups = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const flush = cards.every(({ suit }) => suit === cards[0].suit);
  const straight = straightHigh(ranks);

  if (flush && straight) return { score: [8, straight], name: straight === 14 ? "ロイヤルフラッシュ" : "ストレートフラッシュ" };
  if (groups[0][1] === 4) return { score: [7, groups[0][0], groups[1][0]], name: "フォーカード" };
  if (groups[0][1] === 3 && groups[1][1] === 2) return { score: [6, groups[0][0], groups[1][0]], name: "フルハウス" };
  if (flush) return { score: [5, ...ranks], name: "フラッシュ" };
  if (straight) return { score: [4, straight], name: "ストレート" };
  if (groups[0][1] === 3) {
    return { score: [3, groups[0][0], ...groups.slice(1).map(([rank]) => rank).sort((a, b) => b - a)], name: "スリーカード" };
  }
  if (groups[0][1] === 2 && groups[1][1] === 2) {
    const pairs = [groups[0][0], groups[1][0]].sort((a, b) => b - a);
    return { score: [2, ...pairs, groups[2][0]], name: "ツーペア" };
  }
  if (groups[0][1] === 2) {
    return { score: [1, groups[0][0], ...groups.slice(1).map(([rank]) => rank).sort((a, b) => b - a)], name: "ワンペア" };
  }
  return { score: [0, ...ranks], name: "ハイカード" };
}

export function evaluateHand(cards) {
  if (cards.length < 5) throw new Error("役の判定には5枚以上のカードが必要です。");
  return combinations(cards).map(evaluateFive).reduce((best, candidate) => (
    compareScores(candidate.score, best.score) > 0 ? candidate : best
  ));
}

function compareScores(left, right) {
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

export class PokerGame {
  constructor({ mode = "draw", random = Math.random, names = ["あなた", "CPU"] } = {}) {
    if (!["draw", "holdem"].includes(mode)) throw new Error("ゲームモードが不正です。");
    if (!Array.isArray(names) || names.length !== 2 || names.some((name) => typeof name !== "string")) {
      throw new Error("プレイヤー名が不正です。");
    }
    this.mode = mode;
    this.random = random;
    this.players = [
      { name: names[0], stack: 500, mp: 5, hand: [], cheats: [], rewriteUses: 0, sleeve: null, lockedOut: false },
      { name: names[1], stack: 500, mp: 5, hand: [], cheats: [], rewriteUses: 0, sleeve: null, lockedOut: false },
    ];
    this.handNumber = 0;
    this.logs = [];
    this.notice = "";
    this.matchOver = false;
    this.phase = "ready";
  }

  startHand() {
    if (this.matchOver) throw new Error("チップが0です。新しいゲームを開始してください。");
    this.handNumber += 1;
    this.deck = shuffledDeck(this.random);
    this.discard = [];
    this.community = [];
    this.pot = 0;
    this.revealed = false;
    this.handNumberThisRound = this.handNumber;
    this.button = (this.handNumber - 1) % 2;
    this.street = this.mode === "holdem" ? "プリフロップ" : "ドロー";
    this.notice = "";
    this.cheatUsed = [[], []];
    this.players.forEach((player) => {
      player.hand = [];
      player.totalContributed = 0;
      player.mp = 5;
      player.cheats = [];
      player.sleeve = null;
      player.lockedOut = false;
    });
    const count = this.mode === "holdem" ? 2 : 5;
    for (let i = 0; i < count; i += 1) {
      for (const player of this.players) player.hand.push(this.drawTop());
    }
    this.players.forEach((player, index) => {
      const blind = index === this.button ? 5 : 10;
      this.pay(index, blind);
      player.streetBet = blind;
    });
    this.currentBet = 10;
    this.acted = [false, false];
    this.turn = this.button;
    this.phase = "bet";
    this.logs.push(`第${this.handNumber}ラウンド開始。${this.street}のベットです。`);
    return this;
  }

  drawTop() {
    const card = this.deck.pop();
    if (!card) throw new Error("山札がありません。");
    return card;
  }

  drawBottom() {
    const card = this.deck.shift();
    if (!card) throw new Error("山札がありません。");
    return card;
  }

  pay(playerIndex, amount) {
    const player = this.players[playerIndex];
    const paid = Math.min(amount, player.stack);
    player.stack -= paid;
    player.totalContributed += paid;
    this.pot += paid;
    return paid;
  }

  getCallAmount(playerIndex) {
    return Math.max(0, this.currentBet - (this.players[playerIndex].streetBet ?? 0));
  }

  getCallOptions(playerIndex = 0) {
    const player = this.players[playerIndex];
    const callAmount = this.getCallAmount(playerIndex);
    const opponent = this.players[1 - playerIndex];
    const maxRaise = Math.max(0, Math.min(
      player.stack - callAmount,
      opponent.stack + opponent.totalContributed - player.totalContributed - callAmount,
    ));
    return {
      callAmount,
      canCheck: callAmount === 0,
      canCall: callAmount > 0,
      canRaise: maxRaise >= 10,
      minRaise: 10,
      maxRaise,
    };
  }

  act(playerIndex, action, raiseBy = 10) {
    if (this.phase !== "bet" || this.turn !== playerIndex) throw new Error("現在はこのプレイヤーの手番ではありません。");
    const player = this.players[playerIndex];
    const callAmount = this.getCallAmount(playerIndex);
    if (action === "fold") {
      this.logs.push(`${player.name}がフォールドしました。`);
      this.awardPot(1 - playerIndex, `${this.players[1 - playerIndex].name}の勝ち。`);
      return;
    }
    if (action === "check") {
      if (callAmount !== 0) throw new Error("チェックできません。");
      this.logs.push(`${player.name}がチェックしました。`);
      this.acted[playerIndex] = true;
    } else if (action === "call") {
      if (callAmount === 0) throw new Error("コールできません。チェックしてください。");
      const paid = this.pay(playerIndex, callAmount);
      player.streetBet += paid;
      this.logs.push(`${player.name}が${paid}チップをコールしました。`);
      this.acted[playerIndex] = true;
    } else if (action === "raise") {
      const amount = Number(raiseBy);
      if (!Number.isInteger(amount) || amount < 10 || amount > this.getCallOptions(playerIndex).maxRaise) {
        throw new Error("レイズ額が不正です。");
      }
      const paid = this.pay(playerIndex, callAmount + amount);
      player.streetBet += paid;
      this.currentBet = player.streetBet;
      this.acted[playerIndex] = true;
      this.acted[1 - playerIndex] = false;
      this.logs.push(`${player.name}がコール後に${amount}チップをレイズしました。`);
    } else {
      throw new Error("不明なアクションです。");
    }

    if (player.stack === 0 || this.players[1 - playerIndex].stack === 0) {
      this.finishShowdown();
      return;
    }
    if (this.acted[0] && this.acted[1] && this.players[0].streetBet === this.players[1].streetBet) {
      this.advance();
      return;
    }
    this.turn = 1 - playerIndex;
  }

  advance() {
    if (this.mode === "draw" && this.street === "ドロー") {
      this.phase = "draw";
      this.drawOrder = [1 - this.button, this.button];
      this.drawTurn = 0;
      return;
    }
    if (this.mode === "draw") {
      this.finishShowdown();
      return;
    }
    const streets = ["プリフロップ", "フロップ", "ターン", "リバー"];
    const next = streets[streets.indexOf(this.street) + 1];
    if (!next) {
      this.finishShowdown();
      return;
    }
    this.street = next;
    if (next === "フロップ") this.community.push(this.drawTop(), this.drawTop(), this.drawTop());
    if (next === "ターン" || next === "リバー") this.community.push(this.drawTop());
    this.resetBetting(1 - this.button);
    this.logs.push(`${this.street}に進みました。`);
  }

  resetBetting(firstPlayer) {
    this.players.forEach((player) => { player.streetBet = 0; });
    this.currentBet = 0;
    this.acted = [false, false];
    this.turn = firstPlayer;
    this.phase = "bet";
  }

  exchange(playerIndex, handIndices) {
    if (this.phase !== "draw" || this.drawOrder[this.drawTurn] !== playerIndex) {
      throw new Error("現在はこのプレイヤーの交換手番ではありません。");
    }
    if (!Array.isArray(handIndices) || handIndices.some((index) => !Number.isInteger(index) || index < 0 || index >= 5)
      || new Set(handIndices).size !== handIndices.length) {
      throw new Error("交換するカードの指定が不正です。");
    }
    const player = this.players[playerIndex];
    handIndices.forEach((index) => {
      this.discard.push(player.hand[index]);
      player.hand[index] = this.drawTop();
    });
    this.logs.push(`${player.name}がカードを${handIndices.length}枚交換しました。`);
    this.drawTurn += 1;
    if (this.drawTurn === this.drawOrder.length) {
      this.street = "最終ベット";
      this.resetBetting(1 - this.button);
      this.logs.push("最終ベットです。");
    }
  }

  useCheat(playerIndex, cheatId, options = {}) {
    if (!["bet", "draw"].includes(this.phase)) throw new Error("このラウンドではイカサマを使えません。");
    const player = this.players[playerIndex];
    const cheat = CHEATS.find(({ id }) => id === cheatId);
    if (!cheat) throw new Error("イカサマの種類が不正です。");
    if (cheat.maxUses !== undefined && player.rewriteUses >= cheat.maxUses) {
      throw new Error(`${cheat.label}は対戦中${cheat.maxUses}回までです。`);
    }
    if (cheat.cost !== undefined && player.mp < cheat.cost) throw new Error("MPが足りません。");
    const opponent = this.players[1 - playerIndex];
    let result;
    if (cheatId === "peek") {
      const requiredCount = Math.min(3, opponent.hand.length);
      const indices = options.handIndices;
      if (!Array.isArray(indices)
        || indices.length !== requiredCount
        || indices.some((index) => !Number.isInteger(index) || index < 0 || index >= opponent.hand.length)
        || new Set(indices).size !== indices.length) {
        throw new Error(`相手の手札から${requiredCount}枚を選択してください。`);
      }
      result = indices.map((index) => ({ index, card: { ...opponent.hand[index] } }));
    } else if (cheatId === "deck") {
      this.validateHandIndex(options.handIndex, player.hand.length);
      const card = options.side === "bottom" ? this.drawBottom() : this.drawTop();
      this.discard.push(player.hand[options.handIndex]);
      player.hand[options.handIndex] = card;
      result = { card: { ...card }, handIndex: options.handIndex };
    } else if (cheatId === "sleeve") {
      this.validateHandIndex(options.handIndex, player.hand.length);
      if (player.sleeve) {
        [player.hand[options.handIndex], player.sleeve] = [player.sleeve, player.hand[options.handIndex]];
        result = { action: "交換", card: { ...player.hand[options.handIndex] } };
      } else {
        player.sleeve = player.hand[options.handIndex];
        player.hand[options.handIndex] = this.drawTop();
        result = { action: "隠す", card: { ...player.hand[options.handIndex] } };
      }
    } else if (cheatId === "discard") {
      this.validateHandIndex(options.handIndex, player.hand.length);
      if (this.discard.length === 0) throw new Error("捨て札がありません。");
      const replacement = this.discard.pop();
      this.discard.push(player.hand[options.handIndex]);
      player.hand[options.handIndex] = { ...replacement };
      result = { handIndex: options.handIndex, card: { ...player.hand[options.handIndex] } };
    } else {
      this.validateHandIndex(options.handIndex, player.hand.length);
      if (!SUITS.includes(options.suit) || !RANKS.includes(Number(options.rank))) {
        throw new Error("書き換える数字またはスートが不正です。");
      }
      player.hand[options.handIndex] = { suit: options.suit, rank: Number(options.rank) };
      player.rewriteUses += 1;
      result = { handIndex: options.handIndex, card: { ...player.hand[options.handIndex] } };
    }
    if (cheat.cost !== undefined) player.mp -= cheat.cost;
    player.cheats.push(cheatId);
    this.cheatUsed[playerIndex].push(cheatId);
    return result;
  }

  validateHandIndex(index, length) {
    if (!Number.isInteger(index) || index < 0 || index >= length) throw new Error("カードを選択してください。");
  }

  challenge(challengerIndex, cheatId) {
    if (!["bet", "draw"].includes(this.phase)) throw new Error("ダウトできるラウンドではありません。");
    const targetIndex = 1 - challengerIndex;
    const challenger = this.players[challengerIndex];
    const target = this.players[targetIndex];
    if (challenger.lockedOut) throw new Error("このラウンドでは再度ダウトできません。");
    if (!CHEATS.some(({ id }) => id === cheatId)) throw new Error("指摘する種類を選択してください。");
    if (this.cheatUsed[targetIndex].includes(cheatId)) {
      const penalty = target.stack;
      target.stack = 0;
      challenger.stack += this.pot + penalty;
      const wonPot = this.pot;
      this.pot = 0;
      this.phase = "settled";
      this.notice = `ダウト成功！ ${target.name}は強制敗北し、${challenger.name}の勝利です。`;
      this.logs.push(`${challenger.name}のダウト成功。${target.name}は強制敗北しました。`);
      this.checkMatchOver();
      return { success: true, penalty, wonPot };
    }
    const penalty = Math.min(challenger.stack, 50);
    challenger.stack -= penalty;
    target.stack += penalty;
    challenger.lockedOut = true;
    this.notice = `ダウト失敗。${penalty}チップを相手に渡し、このラウンドは再指摘できません。`;
    this.logs.push(`${challenger.name}のダウト失敗。`);
    this.checkMatchOver();
    return { success: false, penalty };
  }

  finishShowdown() {
    this.returnUncalledBet();
    if (this.mode === "holdem" && this.community.length < 5) {
      while (this.community.length < 5) this.community.push(this.drawTop());
    }
    const scores = this.players.map((player) => evaluateHand(
      this.mode === "holdem" ? [...player.hand, ...this.community] : player.hand,
    ));
    const comparison = compareScores(scores[0].score, scores[1].score);
    if (comparison === 0) {
      const share = Math.floor(this.pot / 2);
      this.players[0].stack += share;
      this.players[1].stack += this.pot - share;
      this.notice = `引き分け。両者の役は${scores[0].name}です。`;
      this.logs.push(`ショーダウンは引き分け（${scores[0].name}）。`);
    } else {
      const winner = comparison > 0 ? 0 : 1;
      this.players[winner].stack += this.pot;
      this.notice = `${this.players[winner].name}の勝ち（${scores[winner].name}）。`;
      this.logs.push(`ショーダウン。${this.players[winner].name}の勝ち（${scores[winner].name}）。`);
    }
    this.pot = 0;
    this.revealed = true;
    this.phase = "settled";
    this.checkMatchOver();
    return scores;
  }

  awardPot(winnerIndex, message) {
    this.returnUncalledBet();
    this.players[winnerIndex].stack += this.pot;
    this.pot = 0;
    this.notice = message;
    this.phase = "settled";
    this.checkMatchOver();
  }

  checkMatchOver() {
    const broke = this.players.find((player) => player.stack === 0);
    if (broke) {
      this.players[1 - this.players.indexOf(broke)].stack += this.pot;
      this.pot = 0;
      this.matchOver = true;
      this.phase = "gameover";
      this.notice = `${broke.name}が破産しました。${this.players[1 - this.players.indexOf(broke)].name}の勝利！`;
    }
  }

  returnUncalledBet() {
    const difference = this.players[0].totalContributed - this.players[1].totalContributed;
    if (difference === 0) return;
    const playerIndex = difference > 0 ? 0 : 1;
    const amount = Math.abs(difference);
    this.players[playerIndex].stack += amount;
    this.players[playerIndex].totalContributed -= amount;
    this.pot -= amount;
  }
}
