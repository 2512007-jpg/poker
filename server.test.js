import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { createPokerServer } from "./server.js";

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextMessage(socket, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Timed out waiting for WebSocket message"));
    }, timeoutMs);
    const onMessage = (data) => {
      const message = JSON.parse(data.toString());
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

function sendRequest(socket, type, fields = {}) {
  const requestId = `${type}-${Math.random()}`;
  const response = nextMessage(socket, (message) => message.requestId === requestId);
  socket.send(JSON.stringify({ type, ...fields, requestId }));
  return response;
}

test("ルーム対戦はサーバーが進行を管理し、相手の手札を隠して再接続できる", async (context) => {
  const application = createPokerServer();
  const address = await application.listen(0, "127.0.0.1");
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const appUrl = `http://127.0.0.1:${address.port}`;
  const sockets = [];
  context.after(async () => {
    sockets.forEach((socket) => socket.terminate());
    await application.close();
  });

  assert.equal((await fetch(appUrl)).status, 200);
  assert.match(await (await fetch(`${appUrl}/multiplayer.js`)).text(), /class MultiplayerClient/);

  const host = await connect(url);
  sockets.push(host);
  const hostWaitingState = nextMessage(host, (message) => message.type === "state");
  const hostSessionResponse = sendRequest(host, "create", { name: "Host", mode: "draw" });
  const hostSession = await hostSessionResponse;
  const waitingState = await hostWaitingState;
  assert.equal(waitingState.game, null);

  const guest = await connect(url);
  sockets.push(guest);
  const hostJoinedState = nextMessage(host, (message) => message.type === "state" && message.connected.every(Boolean));
  const guestJoinedState = nextMessage(guest, (message) => message.type === "state");
  const guestSessionResponse = sendRequest(guest, "join", { name: "Guest", roomCode: hostSession.roomCode });
  await guestSessionResponse;
  await hostJoinedState;
  await guestJoinedState;

  const hostStartedState = nextMessage(host, (message) => message.type === "state" && message.game?.phase === "bet");
  const guestStartedState = nextMessage(guest, (message) => message.type === "state" && message.game?.phase === "bet");
  await sendRequest(host, "start");
  const hostView = await hostStartedState;
  const guestView = await guestStartedState;
  assert.equal(hostView.game.players[0].hand.length, 5);
  assert.ok(hostView.game.players[0].hand.every(Boolean));
  assert.deepEqual(hostView.game.players[1].hand, [null, null, null, null, null]);
  assert.ok(guestView.game.players[1].hand.every(Boolean));
  assert.deepEqual(guestView.game.players[0].hand, [null, null, null, null, null]);

  const rejectedAction = await sendRequest(guest, "action", { action: "check" });
  assert.equal(rejectedAction.type, "error");
  assert.match(rejectedAction.message, /手番ではありません/);

  const hostAfterCheat = nextMessage(host, (message) => message.type === "state");
  const guestAfterCheat = nextMessage(guest, (message) => message.type === "state");
  const privatePeek = await sendRequest(host, "cheat", {
    cheatId: "peek",
    options: { handIndices: [0, 1, 2] },
  });
  const hostCheatState = await hostAfterCheat;
  const guestCheatState = await guestAfterCheat;
  assert.equal(privatePeek.type, "result");
  assert.equal(privatePeek.result.length, 3);
  assert.deepEqual(guestCheatState.game.players[0].hand, [null, null, null, null, null]);
  assert.deepEqual(hostCheatState.game.players[1].hand, [null, null, null, null, null]);

  await new Promise((resolve) => {
    guest.once("close", resolve);
    guest.close();
  });
  const resumed = await connect(url);
  sockets.push(resumed);
  const resumedState = nextMessage(resumed, (message) => message.type === "state");
  await sendRequest(resumed, "resume", { token: (await guestSessionResponse).token });
  const resumedView = await resumedState;
  assert.equal(resumedView.playerIndex, 1);
  assert.deepEqual(resumedView.game.players[0].hand, [null, null, null, null, null]);
});
