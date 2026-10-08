import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { PokerGame } from "./game.js";

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_TTL = 2 * 60 * 60 * 1000;
const MAX_MESSAGE_SIZE = 8 * 1024;
const CONTENT_TYPES = {
  "/": "text/html; charset=utf-8",
  "/index.html": "text/html; charset=utf-8",
  "/app.js": "text/javascript; charset=utf-8",
  "/game.js": "text/javascript; charset=utf-8",
  "/multiplayer.js": "text/javascript; charset=utf-8",
  "/styles.css": "text/css; charset=utf-8",
};

function createRoomCode(rooms) {
  let code;
  do {
    code = Array.from(randomBytes(6), (byte) => ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length]).join("");
  } while (rooms.has(code));
  return code;
}

function send(socket, message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function playerIndexFor(room, socket) {
  return room.players.findIndex((player) => player?.socket === socket);
}

function publicState(room, playerIndex) {
  const game = room.game;
  if (!game) {
    return {
      game: null,
      roomCode: room.code,
      mode: room.mode,
      playerNames: room.players.map((player) => player?.name ?? null),
      playerIndex,
      isHost: playerIndex === 0,
      connected: room.players.map((player) => Boolean(player?.socket)),
    };
  }

  const players = game.players.map((player, index) => ({
    name: player.name,
    stack: player.stack,
    hand: index === playerIndex || game.revealed ? player.hand : player.hand.map(() => null),
    mp: index === playerIndex ? player.mp : null,
    rewriteUses: index === playerIndex ? player.rewriteUses : null,
    sleeve: index === playerIndex ? player.sleeve : null,
    lockedOut: index === playerIndex ? player.lockedOut : false,
    streetBet: player.streetBet ?? 0,
  }));

  return {
    game: {
      mode: game.mode,
      handNumber: game.handNumber,
      phase: game.phase,
      street: game.street,
      players,
      community: game.community,
      pot: game.pot,
      revealed: game.revealed,
      notice: game.notice,
      logs: game.logs,
      matchOver: game.matchOver,
      turn: game.turn,
      drawOrder: game.drawOrder,
      drawTurn: game.drawTurn,
      callOptions: game.getCallOptions(playerIndex),
    },
    roomCode: room.code,
    playerIndex,
    isHost: playerIndex === 0,
    connected: room.players.map((player) => Boolean(player?.socket)),
  };
}

function sendRoomState(room) {
  room.players.forEach((player, index) => {
    if (player?.socket) send(player.socket, { type: "state", ...publicState(room, index) });
  });
}

function normalizeName(value) {
  if (typeof value !== "string") throw new Error("プレイヤー名を入力してください。");
  const name = value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 20);
  if (!name) throw new Error("プレイヤー名を入力してください。");
  return name;
}

function createToken() {
  return randomBytes(32).toString("hex");
}

export function createPokerServer() {
  const rooms = new Map();
  const sockets = new Set();
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const contentType = CONTENT_TYPES[pathname];
    if (!contentType || request.method !== "GET") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    const file = pathname === "/" ? "index.html" : pathname.slice(1);
    import("node:fs").then(({ readFile }) => {
      readFile(new URL(`./${file}`, import.meta.url), (error, contents) => {
        if (error) {
          response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          response.end("Unable to load the application.");
          return;
        }
        response.writeHead(200, {
          "Content-Type": contentType,
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(contents);
      });
    });
  });
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_SIZE });

  function expireRoom(room) {
    if (room.expiry) clearTimeout(room.expiry);
    room.expiry = setTimeout(() => {
      rooms.delete(room.code);
      room.players.forEach((player) => player?.socket?.close(1000, "Room expired"));
    }, ROOM_TTL);
    room.expiry.unref();
  }

  function attach(room, index, socket, requestId) {
    const player = room.players[index];
    if (player.socket && player.socket !== socket) player.socket.close(4001, "Session resumed elsewhere");
    player.socket = socket;
    socket.roomCode = room.code;
    socket.playerIndex = index;
    send(socket, {
      type: "session",
      requestId,
      roomCode: room.code,
      token: player.token,
      playerIndex: index,
      name: player.name,
    });
    sendRoomState(room);
    expireRoom(room);
  }

  function fail(socket, requestId, error) {
    send(socket, {
      type: "error",
      requestId,
      message: error instanceof Error ? error.message : "処理に失敗しました。",
    });
  }

  function handleMessage(socket, message) {
    const requestId = typeof message.requestId === "string" ? message.requestId : undefined;
    if (message.type === "create") {
      if (socket.roomCode) throw new Error("すでにルームに参加しています。");
      const name = normalizeName(message.name);
      if (!["draw", "holdem"].includes(message.mode)) throw new Error("ゲームモードが不正です。");
      if (rooms.size >= 1000) throw new Error("現在ルームを作成できません。時間をおいて再度お試しください。");
      const code = createRoomCode(rooms);
      const room = {
        code,
        mode: message.mode,
        players: [{ name, token: createToken(), socket }, null],
        game: null,
        expiry: null,
      };
      rooms.set(code, room);
      socket.roomCode = code;
      socket.playerIndex = 0;
      send(socket, { type: "session", requestId, roomCode: code, token: room.players[0].token, playerIndex: 0, name });
      sendRoomState(room);
      expireRoom(room);
      return;
    }

    if (message.type === "join") {
      if (socket.roomCode) throw new Error("すでにルームに参加しています。");
      const code = typeof message.roomCode === "string" ? message.roomCode.trim().toUpperCase() : "";
      const room = rooms.get(code);
      if (!room) throw new Error("ルームが見つかりません。コードを確認してください。");
      if (room.players[1]) throw new Error("このルームは満員です。");
      const name = normalizeName(message.name);
      room.players[1] = { name, token: createToken(), socket };
      socket.roomCode = code;
      socket.playerIndex = 1;
      send(socket, { type: "session", requestId, roomCode: code, token: room.players[1].token, playerIndex: 1, name });
      sendRoomState(room);
      expireRoom(room);
      return;
    }

    if (message.type === "resume") {
      if (socket.roomCode || typeof message.token !== "string") throw new Error("再接続情報が不正です。");
      const room = [...rooms.values()].find((candidate) => candidate.players.some((player) => player?.token === message.token));
      const index = room?.players.findIndex((player) => player?.token === message.token) ?? -1;
      if (!room || index < 0) throw new Error("再接続できるルームが見つかりません。");
      attach(room, index, socket, requestId);
      return;
    }

    if (message.type === "leave") {
      const room = rooms.get(socket.roomCode);
      if (room) {
        rooms.delete(room.code);
        if (room.expiry) clearTimeout(room.expiry);
        room.players.forEach((player) => {
          if (player?.socket && player.socket !== socket) {
            send(player.socket, { type: "roomClosed", message: "対戦相手がルームを退出しました。" });
            player.socket.close(1000, "Room closed");
          }
        });
      }
      socket.close(1000, "Player left");
      return;
    }

    const room = rooms.get(socket.roomCode);
    const index = room ? playerIndexFor(room, socket) : -1;
    if (!room || index < 0) throw new Error("ルームに参加していません。");
    if (message.type === "start") {
      if (index !== 0) throw new Error("ゲームを開始できるのはルーム作成者です。");
      if (!room.players[1]) throw new Error("対戦相手の参加を待っています。");
      if (room.game) throw new Error("ゲームはすでに開始されています。");
      room.game = new PokerGame({ mode: room.mode, names: room.players.map((player) => player.name) }).startHand();
    } else if (message.type === "next") {
      if (index !== 0) throw new Error("次のラウンドを開始できるのはルーム作成者です。");
      if (!room.game || room.game.phase !== "settled") throw new Error("次のラウンドを開始できません。");
      room.game.startHand();
    } else if (message.type === "restart") {
      if (index !== 0) throw new Error("新しいゲームを開始できるのはルーム作成者です。");
      if (!room.game?.matchOver) throw new Error("ゲーム終了後に新しいゲームを開始できます。");
      room.game = new PokerGame({ mode: room.game.mode, names: room.players.map((player) => player.name) }).startHand();
    } else {
      if (!room.game) throw new Error("対戦相手の参加を待っています。");
      if (message.type === "action") {
        room.game.act(index, message.action, message.amount);
      } else if (message.type === "exchange") {
        room.game.exchange(index, message.handIndices);
      } else if (message.type === "cheat") {
        if (!message.options || typeof message.options !== "object" || Array.isArray(message.options)) {
          throw new Error("イカサマの指定が不正です。");
        }
        const result = room.game.useCheat(index, message.cheatId, message.options);
        send(socket, { type: "result", requestId, result });
        send(room.players[1 - index]?.socket, { type: "opponentTell" });
      } else if (message.type === "challenge") {
        const result = room.game.challenge(index, message.cheatId);
        send(socket, { type: "result", requestId, result });
      } else {
        throw new Error("不明なリクエストです。");
      }
    }
    if (message.type !== "cheat" && message.type !== "challenge") {
      send(socket, { type: "result", requestId });
    }
    sendRoomState(room);
    expireRoom(room);
  }

  server.on("upgrade", (request, socket, head) => {
    const origin = request.headers.origin;
    if (origin) {
      let originHost;
      try {
        originHost = new URL(origin).host;
      } catch {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      if (originHost !== request.headers.host) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
    }
    if (new URL(request.url, "http://localhost").pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      webSockets.emit("connection", webSocket, request);
    });
  });

  webSockets.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("message", (data, isBinary) => {
      let message;
      try {
        if (isBinary) throw new Error("不正なメッセージ形式です。");
        message = JSON.parse(data.toString());
        if (!message || typeof message !== "object" || Array.isArray(message)) {
          throw new Error("不正なメッセージ形式です。");
        }
        handleMessage(socket, message);
      } catch (error) {
        fail(socket, typeof message?.requestId === "string" ? message.requestId : undefined, error);
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
      const room = rooms.get(socket.roomCode);
      if (room && room.players[socket.playerIndex]?.socket === socket) {
        room.players[socket.playerIndex].socket = null;
        sendRoomState(room);
        expireRoom(room);
      }
    });
  });

  return {
    server,
    listen(port = Number(process.env.PORT) || 8000, host = process.env.HOST || "0.0.0.0") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve(server.address());
        });
      });
    },
    close() {
      for (const socket of sockets) socket.close(1001, "Server shutting down");
      for (const room of rooms.values()) if (room.expiry) clearTimeout(room.expiry);
      return new Promise((resolve, reject) => {
        webSockets.close((webSocketError) => {
          server.close((serverError) => {
            if (webSocketError || serverError) reject(webSocketError ?? serverError);
            else resolve();
          });
        });
      });
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const application = createPokerServer();
  application.listen().then(({ port }) => {
    console.log(`イカサマポーカーを http://localhost:${port} で起動しました`);
  }).catch((error) => {
    console.error("サーバーを起動できませんでした:", error);
    process.exitCode = 1;
  });
}
