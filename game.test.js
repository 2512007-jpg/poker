import test from "node:test";
import assert from "node:assert/strict";
import { evaluateHand, PokerGame, SUITS, RANKS } from "./game.js";

const hand = (cards) => cards.map(([rank, suit = "♠"]) => ({ rank, suit }));

test("役を強い順に判定し、同じ役はキッカーで比較する", () => {
  assert.equal(evaluateHand(hand([[14, "♠"], [13, "♠"], [12, "♠"], [11, "♠"], [10, "♠"]])).score[0], 8);
  assert.equal(evaluateHand(hand([[5], [4], [3], [2], [14]])).score[1], 5);
  const pairOfAces = evaluateHand(hand([[14], [14, "♥"], [9, "♦"], [7, "♣"], [2, "♦"]]));
  const pairOfKings = evaluateHand(hand([[13], [13, "♥"], [14, "♦"], [7, "♣"], [2, "♦"]]));
  assert.ok(pairOfAces.score[1] > pairOfKings.score[1]);
});

test("両モードを開始し、ブラインドと手札を正しく配る", () => {
  for (const mode of ["draw", "holdem"]) {
    const game = new PokerGame({ mode, random: () => 0.5 }).startHand();
    assert.equal(game.phase, "bet");
    assert.equal(game.players[0].hand.length, mode === "draw" ? 5 : 2);
    assert.equal(game.players[1].hand.length, mode === "draw" ? 5 : 2);
    assert.equal(game.pot, 15);
    assert.equal(game.players.reduce((sum, player) => sum + player.stack, 0) + game.pot, 1000);
  }
});

test("MPを使うイカサマはMPを消費し、使用記録を対戦ログに残さない", () => {
  const game = new PokerGame().startHand();
  game.useCheat(0, "deck", { handIndex: 0, side: "top" });
  game.useCheat(0, "deck", { handIndex: 0, side: "top" });
  assert.equal(game.players[0].mp, 1);
  assert.deepEqual(game.cheatUsed[0], ["deck", "deck"]);
  assert.ok(game.logs.every((line) => !line.includes("山札操作")));
  assert.throws(() => game.useCheat(0, "peek"), /MPが足りません/);
});

test("書き換えはMPを消費しない", () => {
  const game = new PokerGame().startHand();
  game.players[0].mp = 0;
  const card = game.useCheat(0, "rewrite", { handIndex: 0, suit: "♦", rank: 14 });
  assert.deepEqual(card.card, game.players[0].hand[0]);
  assert.equal(game.players[0].mp, 0);
  assert.equal(game.players[0].rewriteUses, 1);
});

test("書き換えは対戦全体で各プレイヤー2回まで", () => {
  const game = new PokerGame().startHand();
  for (let i = 0; i < 2; i += 1) {
    game.useCheat(0, "rewrite", { handIndex: 0, suit: "♦", rank: 14 });
    game.startHand();
  }

  const originalCard = { ...game.players[0].hand[0] };
  assert.equal(game.players[0].rewriteUses, 2);
  assert.throws(
    () => game.useCheat(0, "rewrite", { handIndex: 0, suit: "♣", rank: 2 }),
    /書き換えは対戦中2回まで/,
  );
  assert.deepEqual(game.players[0].hand[0], originalCard);
  assert.equal(game.players[0].mp, 5);

  game.useCheat(1, "rewrite", { handIndex: 0, suit: "♣", rank: 2 });
  assert.equal(game.players[1].rewriteUses, 1);
});

test("透視は指定した3枚だけを返し、ホールデムでは手札2枚を確認する", () => {
  const draw = new PokerGame({ mode: "draw" }).startHand();
  const expected = [0, 2, 4].map((index) => draw.players[1].hand[index]);
  const seen = draw.useCheat(0, "peek", { handIndices: [0, 2, 4] });
  assert.deepEqual(seen.map(({ index }) => index), [0, 2, 4]);
  assert.deepEqual(seen.map(({ card }) => card), expected);
  assert.equal(draw.players[0].mp, 2);
  assert.throws(() => new PokerGame({ mode: "draw" }).startHand().useCheat(0, "peek", { handIndices: [0, 1] }), /3枚を選択/);

  const holdem = new PokerGame({ mode: "holdem" }).startHand();
  const holdemSeen = holdem.useCheat(0, "peek", { handIndices: [0, 1] });
  assert.equal(holdemSeen.length, 2);
  assert.deepEqual(holdemSeen.map(({ card }) => card), holdem.players[1].hand);
});

test("袖の下は手札を預け、後から別のカードと交換する", () => {
  const game = new PokerGame().startHand();
  const kept = game.players[0].hand[0];
  game.useCheat(0, "sleeve", { handIndex: 0 });
  assert.notDeepEqual(game.players[0].hand[0], kept);
  game.useCheat(0, "sleeve", { handIndex: 1 });
  assert.deepEqual(game.players[0].hand[1], kept);
  assert.equal(game.players[0].mp, 1);
});

test("正しいダウトでラウンドに勝ち、誤った指摘は再指摘をロックする", () => {
  const caught = new PokerGame().startHand();
  caught.useCheat(1, "peek", { handIndices: [0, 1, 2] });
  assert.equal(caught.challenge(0, "peek").success, true);
  assert.equal(caught.phase, "gameover");
  assert.equal(caught.matchOver, true);
  assert.equal(caught.players[1].stack, 0);
  assert.ok(caught.players[0].stack > 500);

  const missed = new PokerGame().startHand();
  assert.equal(missed.challenge(0, "rewrite").success, false);
  assert.equal(missed.players[0].lockedOut, true);
  assert.throws(() => missed.challenge(0, "peek"), /再度ダウトできません/);
});

test("ドロー交換、ベッティング、ホールデムのコミュニティカードが進行する", () => {
  const draw = new PokerGame({ mode: "draw" }).startHand();
  draw.act(draw.turn, "call");
  draw.act(draw.turn, "check");
  assert.equal(draw.phase, "draw");
  draw.exchange(draw.drawOrder[0], [0, 1]);
  draw.exchange(draw.drawOrder[1], []);
  assert.equal(draw.phase, "bet");
  assert.equal(draw.street, "最終ベット");
  const holdem = new PokerGame({ mode: "holdem" }).startHand();
  holdem.act(holdem.turn, "call");
  holdem.act(holdem.turn, "check");
  assert.equal(holdem.street, "フロップ");
  assert.equal(holdem.community.length, 3);
});

test("ホールデムは5枚の共有カードでショーダウンし、チップを保存する", () => {
  const game = new PokerGame({ mode: "holdem" }).startHand();
  game.act(game.turn, "call");
  game.act(game.turn, "check");
  while (game.phase === "bet") {
    game.act(game.turn, "check");
    game.act(game.turn, "check");
  }
  assert.equal(game.phase, "settled");
  assert.equal(game.community.length, 5);
  assert.equal(game.revealed, true);
  assert.equal(game.players[0].stack + game.players[1].stack + game.pot, 1000);
});

test("フォールドでポットを相手に渡し、ベットログを残す", () => {
  const game = new PokerGame().startHand();
  const winner = 1 - game.turn;
  const expectedStack = game.players[winner].stack + game.pot;
  game.act(game.turn, "fold");
  assert.equal(game.phase, "settled");
  assert.equal(game.players[winner].stack, expectedStack);
  assert.equal(game.pot, 0);
  assert.ok(game.logs.some((line) => line.includes("フォールド")));
});

test("短いスタックのオールインでは未対抗分を返却してチップを保存する", () => {
  const game = new PokerGame({ mode: "holdem" }).startHand();
  game.players[1].stack += game.players[0].stack - 3;
  game.players[0].stack = 3;
  game.act(game.turn, "call");
  assert.ok(["settled", "gameover"].includes(game.phase));
  assert.equal(game.players[0].totalContributed, game.players[1].totalContributed);
  assert.equal(game.players[0].stack + game.players[1].stack + game.pot, 1000);
});

test("カード定義は一組52枚の範囲", () => {
  assert.equal(SUITS.length * RANKS.length, 52);
});
